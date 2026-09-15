import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClaimStatus, Prisma } from '@prisma/client';
import { AppError, AuditActions, ErrorCodes, restrictedCampusId, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { parseCsv } from '../students/students-import.service';
import type { ImportStatementDto } from './dto/fees.dto';

/** How far a claim's `paidOn` may sit from the bank's value date and still be the same money. */
const DATE_TOLERANCE_DAYS = 2;

/**
 * How strongly the statement corroborates a claim. Ordered; the matcher stops at the first hit.
 *
 * ⚠️ `WEAK` exists to be *excluded*. Amount and date alone match two families who each paid
 * Rs 15,000 on the same morning — which is ordinary, not exceptional — so it is computed, labelled,
 * and never presented as a match. A matcher that guesses between two children is worse than one
 * that stays silent.
 */
export type MatchConfidence = 'EXACT' | 'STRONG' | 'PROBABLE' | 'WEAK';

export interface LineMatch {
  claimId: string;
  confidence: MatchConfidence;
  /** Why, in the words the accountant would use. Shown beside the row. */
  reason: string;
}

interface ParsedLine {
  valueDate: Date;
  amount: number;
  narration: string;
  reference: string | null;
  counterparty: string | null;
  fingerprint: string;
}

/**
 * Bank statement reconciliation (Fees Gaps Register).
 *
 * The accountant used to match every claim against a statement open in another window, by eye.
 * This uploads the statement so the SEARCHING is automatic.
 *
 * ⚠️ **Matching is evidence, never a decision.** Nothing in this service verifies a claim, writes a
 * payment, mints a receipt or touches an invoice. Verification stays a human act running the
 * ordinary payment path with a named verifier recorded for ever — the submission plan is blunt
 * about why: *"Auto-verifying a screenshot is how a school gets defrauded."* A statement match only
 * decides what the accountant is shown first.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid() {
    return this.ctx.schoolId!;
  }

  /**
   * Parse and match WITHOUT writing — the same dry-run shape as the student CSV import.
   *
   * An accountant uploading a bank statement for the first time has no idea whether the column
   * mapping is right. Showing them the parsed result before anything is stored is the difference
   * between a mistake they can see and a table they have to clean up.
   */
  async preview(dto: ImportStatementDto) {
    const lines = this.parseLines(dto);
    const matches = await this.matchAll(lines);
    return this.summarise(lines, matches, { committed: false });
  }

  /**
   * Store the statement and its lines, and record the matches found.
   *
   * ⚠️ Idempotent by FINGERPRINT, not by file. Accountants re-download overlapping date ranges as a
   * matter of course ("last 7 days", every day), so the same credit arrives repeatedly. A line
   * already seen for this school is skipped, and re-uploading an identical statement writes
   * nothing at all.
   */
  async commit(dto: ImportStatementDto) {
    const lines = this.parseLines(dto);
    if (lines.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'No credit lines found in that file');
    }
    const matches = await this.matchAll(lines);

    const existing = await this.db.bankStatementLine.findMany({
      where: { fingerprint: { in: lines.map((l) => l.fingerprint) } },
      select: { fingerprint: true },
    });
    const seen = new Set(existing.map((e) => e.fingerprint));
    const fresh = lines.filter((l) => !seen.has(l.fingerprint));

    const dates = lines.map((l) => l.valueDate.getTime());
    const statement = await this.db.bankStatement.create({
      data: {
        schoolId: this.sid,
        bankLabel: dto.bankLabel,
        fileName: dto.fileName ?? null,
        periodFrom: new Date(Math.min(...dates)),
        periodTo: new Date(Math.max(...dates)),
        lineCount: fresh.length,
        uploadedById: this.ctx.user?.userId ?? null,
      },
    });

    for (const line of fresh) {
      // Only a match the accountant would accept without argument is recorded on the row itself.
      // PROBABLE is shown as a suggestion in the queue and left for a person to confirm.
      const match = matches.get(line.fingerprint);
      const link = match && (match.confidence === 'EXACT' || match.confidence === 'STRONG');
      await this.db.bankStatementLine.create({
        data: {
          schoolId: this.sid,
          statementId: statement.id,
          valueDate: line.valueDate,
          amount: line.amount,
          narration: line.narration,
          reference: line.reference,
          counterparty: line.counterparty,
          fingerprint: line.fingerprint,
          matchedClaimId: link ? match.claimId : null,
          matchedAt: link ? new Date() : null,
        },
      });
    }

    await this.audit.record({
      action: AuditActions.FEE_STATEMENT_IMPORTED,
      entityType: 'BankStatement',
      entityId: statement.id,
      newValue: { bankLabel: dto.bankLabel, parsed: lines.length, stored: fresh.length, skipped: lines.length - fresh.length },
    });

    return { statementId: statement.id, ...this.summarise(lines, matches, { committed: true, stored: fresh.length }) };
  }

  /**
   * Credits the school has received and cannot explain.
   *
   * ⚠️ **The most valuable output of the feature, and the one nobody asks for.** A parent who paid
   * and never told the school is invisible today: the child stays on the defaulter list and can be
   * stopped at an exam hall over money the school already holds.
   */
  async unexplained(days = 60) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.bankStatementLine.findMany({
      where: { matchedClaimId: null, valueDate: { gte: since } },
      orderBy: { valueDate: 'desc' },
      include: { statement: { select: { bankLabel: true } } },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      valueDate: r.valueDate,
      amount: r.amount,
      narration: r.narration,
      reference: r.reference,
      counterparty: r.counterparty,
      bankLabel: r.statement.bankLabel,
    }));
  }

  // ── parsing ───────────────────────────────────────────────────────────────

  /**
   * Turn the uploaded CSV into credit lines.
   *
   * ⚠️ The column MAP is what makes this work against a bank nobody has seen. HBL, Meezan, UBL and
   * Alfalah each export different headers, and hard-coding any one of them would make the feature
   * work for exactly one school. The accountant maps their columns once; the label remembers it.
   */
  private parseLines(dto: ImportStatementDto): ParsedLine[] {
    const { header, rows } = parseCsv(dto.csv);
    const map = dto.columns;
    const idx = (name: string | undefined) => (name ? header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase()) : -1);

    const cDate = idx(map.valueDate);
    const cCredit = idx(map.credit);
    if (cDate === -1 || cCredit === -1) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Could not find the date and credit columns. The file has: ${header.join(', ')}`,
      );
    }
    const cNarration = idx(map.narration);
    const cReference = idx(map.reference);
    const cCounterparty = idx(map.counterparty);

    const out: ParsedLine[] = [];
    for (const cells of rows) {
      const amount = parseAmount(cells[cCredit]);
      // Debits and zero rows are not fee income. A statement is mostly noise from this angle.
      if (amount === null || amount <= 0) continue;
      const valueDate = parseDate(cells[cDate]);
      if (!valueDate) continue;

      const narration = (cNarration === -1 ? '' : cells[cNarration] ?? '').trim().slice(0, 500);
      const reference = cReference === -1 ? null : (cells[cReference] ?? '').trim() || null;
      const counterparty = cCounterparty === -1 ? null : (cells[cCounterparty] ?? '').trim().slice(0, 200) || null;

      out.push({
        valueDate,
        amount,
        narration,
        reference,
        counterparty,
        fingerprint: fingerprintOf(valueDate, amount, reference, narration),
      });
    }
    return out;
  }

  // ── matching ──────────────────────────────────────────────────────────────

  /**
   * Score every parsed line against the claims still awaiting a human.
   *
   * Only PENDING claims are considered: a verified claim already has a receipt, and re-matching it
   * would invite a second one.
   */
  private async matchAll(lines: ParsedLine[]): Promise<Map<string, LineMatch>> {
    if (lines.length === 0) return new Map();
    const dates = lines.map((l) => l.valueDate.getTime());
    const from = new Date(Math.min(...dates) - DATE_TOLERANCE_DAYS * 86_400_000);
    const to = new Date(Math.max(...dates) + DATE_TOLERANCE_DAYS * 86_400_000);

    const restricted = restrictedCampusId(this.ctx.user);
    const where: Prisma.FeePaymentClaimWhereInput = {
      status: ClaimStatus.PENDING,
      paidOn: { gte: from, lte: to },
      ...(restricted !== null ? { invoice: { enrollment: { campusId: restricted } } } : {}),
    };
    const claims = await this.db.feePaymentClaim.findMany({
      where,
      select: {
        id: true, amount: true, transactionRef: true, paidOn: true,
        student: { select: { fullName: true } },
      },
    });

    const taken = new Set<string>();
    const out = new Map<string, LineMatch>();
    // Strongest tier first across ALL lines, so an exact reference wins a claim before a weaker
    // line can take it. Matching line-by-line would let row 3's fuzzy guess consume the claim that
    // row 40's exact reference was going to prove.
    for (const tier of ['EXACT', 'STRONG', 'PROBABLE'] as const) {
      for (const line of lines) {
        if (out.has(line.fingerprint)) continue;
        for (const claim of claims) {
          if (taken.has(claim.id)) continue;
          const m = scoreClaim(line, claim);
          if (m?.confidence !== tier) continue;
          out.set(line.fingerprint, { claimId: claim.id, confidence: tier, reason: m.reason });
          taken.add(claim.id);
          break;
        }
      }
    }
    return out;
  }

  private summarise(lines: ParsedLine[], matches: Map<string, LineMatch>, meta: Record<string, unknown>) {
    const rows = lines.map((l) => {
      const m = matches.get(l.fingerprint);
      return {
        valueDate: l.valueDate,
        amount: l.amount,
        narration: l.narration,
        reference: l.reference,
        counterparty: l.counterparty,
        match: m ?? null,
      };
    });
    return {
      ...meta,
      parsed: lines.length,
      matched: rows.filter((r) => r.match).length,
      unexplained: rows.filter((r) => !r.match).length,
      rows,
    };
  }
}

// ── pure helpers, exported so they can be tested without a database ──────────

export function fingerprintOf(valueDate: Date, amount: number, reference: string | null, narration: string): string {
  const key = [valueDate.toISOString().slice(0, 10), amount.toFixed(2), reference ?? '', narration].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** `1,234.50`, `Rs 1,234.50`, `(1,234.50)` and a bare number all mean the same thing to a bank. */
export function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.\-()]/g, '').replace(/\((.*)\)/, '-$1');
  if (!cleaned || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Accept the formats Pakistani banks actually emit.
 *
 * ⚠️ `DD/MM/YYYY` is assumed over `MM/DD/YYYY` — the local convention. An ambiguous `03/04/2026`
 * therefore reads as 3 April. Getting this backwards silently shifts every line by months, so it is
 * stated rather than inferred.
 */
export function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** Compare loosely enough to survive human typing: case, spaces and punctuation are noise. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function scoreClaim(
  line: { valueDate: Date; amount: number; narration: string; reference: string | null; counterparty: string | null },
  claim: { amount: Prisma.Decimal | number; transactionRef: string | null; paidOn: Date; student: { fullName: string } },
): { confidence: MatchConfidence; reason: string } | null {
  const claimAmount = Number(claim.amount);
  const sameAmount = Math.abs(claimAmount - line.amount) < 0.01;
  const daysApart = Math.abs(line.valueDate.getTime() - new Date(claim.paidOn).getTime()) / 86_400_000;
  const closeInTime = daysApart <= DATE_TOLERANCE_DAYS;
  const ref = claim.transactionRef?.trim();

  // Tier 1 — the bank gave us a reference column and it is the one the parent typed.
  if (ref && line.reference && norm(line.reference) === norm(ref)) {
    return { confidence: 'EXACT', reason: `Reference ${ref} matches the statement` };
  }
  // Tier 2 — the reference is buried in free text, which is where it usually lives.
  if (ref && ref.length >= 4 && norm(line.narration).includes(norm(ref))) {
    return { confidence: 'STRONG', reason: `Reference ${ref} found in the narration` };
  }
  if (!sameAmount || !closeInTime) return null;

  // Tier 3 — no usable reference, but amount, date and a name all agree.
  const names = [line.counterparty, line.narration].filter(Boolean).map((v) => norm(v as string));
  const surname = claim.student.fullName.split(/\s+/).filter((p) => p.length >= 4).map(norm);
  if (surname.some((p) => names.some((n) => n.includes(p)))) {
    return { confidence: 'PROBABLE', reason: `Amount and date match, and the payer's name resembles ${claim.student.fullName}` };
  }

  // Tier 4 — amount and date only. Deliberately NOT a match: two families paying the same fee on
  // the same morning is ordinary, and picking between them is the one thing this must not do.
  return { confidence: 'WEAK', reason: 'Amount and date match, but nothing identifies the payer' };
}
