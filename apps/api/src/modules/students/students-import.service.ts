import { HttpStatus, Injectable } from '@nestjs/common';
import { Gender, GuardianRelation } from '@prisma/client';
import {
  AppError,
  ErrorCodes,
  normalizePkPhone,
  parseSchoolSettings,
  restrictedCampusId,
  TenantContext,
} from '@common';
import { TenantPrismaService } from '@database';
import { StudentsService } from './students.service';
import { GuardiansService } from './guardians.service';
import type { GuardianResolutionDto } from './dto/student.dto';

/** Max data rows per import — keeps one request (and its transaction) bounded. */
const MAX_ROWS = 1000;

const REQUIRED_COLUMNS = [
  'fullName',
  'gender',
  'dateOfBirth',
  'className',
  'sectionName',
  'guardianName',
  'guardianPhone',
  'relation',
] as const;

export interface ImportRowError {
  row: number; // 1-based CSV line (row 1 is the header)
  field?: string;
  message: string;
}

export interface ImportResult {
  rows: number; // data rows parsed
  imported: number;
  failed: number; // rows with ≥1 validation error (import is all-or-nothing)
  dryRun: boolean;
  errors: ImportRowError[];
  students: { row: number; studentId: string; grNumber: string }[];
}

interface ParsedRow {
  row: number; // CSV line number for the user
  fullName: string;
  gender: string;
  dateOfBirth: string;
  className: string;
  sectionName: string;
  campusName: string;
  guardianName: string;
  guardianPhone: string;
  relation: string;
  guardianCnic: string;
  guardianEmail: string;
  grNumber: string;
  // resolved during validation
  classId?: string;
  sectionId?: string;
}

/**
 * Bulk student import from CSV (blueprint §22.6 — pilot onboarding). Strategy:
 * VALIDATE the whole file first (read-only) and report every bad row; only if the
 * file is clean do we WRITE — all-or-nothing. This gives a precise per-row error
 * report ("fix and re-upload") without leaving a half-imported mess, and sidesteps
 * the fact that a single DB error inside the request transaction would poison it
 * and roll everything back anyway. `dryRun` validates without writing.
 *
 * Each row reuses the shared `createStudentCore` (admit-in-one-tx), so imported
 * students go through the exact same rules as a manual add — campus scoping, GR
 * assignment, section capacity, guardian resolution. Guardians resolve by phone:
 * an existing parent is LINKED (so siblings share one account), otherwise CREATED.
 */
@Injectable()
export class StudentsImportService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly students: StudentsService,
    private readonly guardians: GuardiansService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async import(csv: string, dryRun = false): Promise<ImportResult> {
    const { header, rows } = parseCsv(csv);
    const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    if (missing.length > 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `CSV is missing required column(s): ${missing.join(', ')}`,
      );
    }
    if (rows.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'CSV has no data rows');
    }
    if (rows.length > MAX_ROWS) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Too many rows (${rows.length}); import at most ${MAX_ROWS} at a time`,
      );
    }

    const idx = (name: string) => header.indexOf(name);
    const parsed: ParsedRow[] = rows.map((cells, i) => {
      const get = (name: string) => (idx(name) >= 0 ? (cells[idx(name)] ?? '').trim() : '');
      return {
        row: i + 2, // +1 for 1-based, +1 for the header line
        fullName: get('fullName'),
        gender: get('gender').toUpperCase(),
        dateOfBirth: get('dateOfBirth'),
        className: get('className'),
        sectionName: get('sectionName'),
        campusName: get('campusName'),
        guardianName: get('guardianName'),
        guardianPhone: get('guardianPhone'),
        relation: get('relation').toUpperCase(),
        guardianCnic: get('guardianCnic'),
        guardianEmail: get('guardianEmail'),
        grNumber: get('grNumber'),
      };
    });

    const errors = await this.validate(parsed);
    const failedRows = new Set(errors.map((e) => e.row)).size;

    if (errors.length > 0 || dryRun) {
      return { rows: parsed.length, imported: 0, failed: failedRows, dryRun, errors, students: [] };
    }

    // Clean file → write. All rows share the request transaction; a rare write-time
    // failure (e.g. a concurrent GR/phone create) aborts and rolls the whole batch back.
    const students: ImportResult['students'] = [];
    for (const r of parsed) {
      const guardian = await this.resolveGuardian(r);
      const created = await this.students.createStudentCore({
        fullName: r.fullName,
        gender: r.gender as Gender,
        dateOfBirth: r.dateOfBirth,
        classId: r.classId!,
        sectionId: r.sectionId!,
        guardian,
        grNumber: r.grNumber || undefined,
      });
      students.push({ row: r.row, studentId: created.studentId, grNumber: created.grNumber });
    }
    return { rows: parsed.length, imported: students.length, failed: 0, dryRun: false, errors: [], students };
  }

  /** Read-only pass: resolve names → ids and validate every field, collecting all errors. */
  private async validate(parsed: ParsedRow[]): Promise<ImportRowError[]> {
    const errors: ImportRowError[] = [];
    const restricted = restrictedCampusId(this.ctx.user);

    // Preload the small placement dimensions once; resolve names in memory.
    const [campuses, classes, sections, school] = await Promise.all([
      this.db.campus.findMany({ select: { id: true, name: true } }),
      this.db.class.findMany({ select: { id: true, name: true, campusId: true } }),
      this.db.section.findMany({ select: { id: true, name: true, classId: true, capacity: true } }),
      this.db.school.findFirst({ where: { id: this.ctx.requireSchoolId() } }),
    ]);
    const visibleCampuses = restricted ? campuses.filter((c) => c.id === restricted) : campuses;
    const campusByName = new Map(visibleCampuses.map((c) => [c.name.toLowerCase(), c.id]));
    const classByKey = new Map(classes.map((c) => [`${c.campusId}|${c.name.toLowerCase()}`, c.id]));
    const sectionByKey = new Map(sections.map((s) => [`${s.classId}|${s.name.toLowerCase()}`, s]));

    const grManual = school?.grNumberMode === 'MANUAL';
    const settings = parseSchoolSettings(school?.settings ?? {});
    const hardCapacity = settings.sectionCapacityMode === 'HARD';

    // Section fill projection (HARD mode only): current ACTIVE count + in-batch assignments.
    const projected = new Map<string, number>();
    if (hardCapacity) {
      const yearId = await this.currentYearIdOrNull();
      if (yearId) {
        const counts = await this.db.studentEnrollment.groupBy({
          by: ['sectionId'],
          where: { academicYearId: yearId, status: 'ACTIVE' },
          _count: { _all: true },
        });
        for (const c of counts) projected.set(c.sectionId, c._count._all);
      }
    }
    const seenGr = new Set<string>();

    for (const r of parsed) {
      const err = (field: string, message: string) => errors.push({ row: r.row, field, message });

      if (!r.fullName) err('fullName', 'required');
      if (!Object.values(Gender).includes(r.gender as Gender)) err('gender', `must be one of ${Object.values(Gender).join('/')}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dateOfBirth) || Number.isNaN(Date.parse(r.dateOfBirth))) {
        err('dateOfBirth', 'must be a valid date (YYYY-MM-DD)');
      }
      if (!Object.values(GuardianRelation).includes(r.relation as GuardianRelation)) {
        err('relation', `must be one of ${Object.values(GuardianRelation).join('/')}`);
      }
      if (!r.guardianName) err('guardianName', 'required');
      if (!normalizePkPhone(r.guardianPhone)) err('guardianPhone', 'invalid phone number');

      // GR number rules.
      if (grManual) {
        if (!r.grNumber) err('grNumber', 'required (school is in MANUAL GR mode)');
        else if (seenGr.has(r.grNumber)) err('grNumber', `duplicated within the file (${r.grNumber})`);
        else {
          seenGr.add(r.grNumber);
          const taken = await this.db.student.findFirst({ where: { grNumber: r.grNumber, deletedAt: null }, select: { id: true } });
          if (taken) err('grNumber', `already exists (${r.grNumber})`);
        }
      }

      // Resolve campus → class → section.
      let campusId: string | undefined;
      if (r.campusName) {
        campusId = campusByName.get(r.campusName.toLowerCase());
        if (!campusId) err('campusName', `unknown or inaccessible campus "${r.campusName}"`);
      } else if (restricted) {
        campusId = restricted;
      } else if (visibleCampuses.length === 1) {
        campusId = visibleCampuses[0].id;
      } else {
        err('campusName', 'required (the school has multiple campuses)');
      }

      if (campusId && r.className) {
        const classId = classByKey.get(`${campusId}|${r.className.toLowerCase()}`);
        if (!classId) err('className', `no class "${r.className}" in this campus`);
        else {
          r.classId = classId;
          const section = sectionByKey.get(`${classId}|${r.sectionName.toLowerCase()}`);
          if (!section) err('sectionName', `no section "${r.sectionName}" in class "${r.className}"`);
          else {
            r.sectionId = section.id;
            if (hardCapacity) {
              const next = (projected.get(section.id) ?? 0) + 1;
              projected.set(section.id, next);
              if (next > section.capacity) err('sectionName', `section "${r.sectionName}" would exceed capacity (${section.capacity})`);
            }
          }
        }
      } else if (!r.className) {
        err('className', 'required');
      }
    }
    return errors;
  }

  /** Import guardian policy: link an existing parent by phone (siblings share one), else create. */
  private async resolveGuardian(r: ParsedRow): Promise<GuardianResolutionDto> {
    const existing = await this.guardians.findByPhone(r.guardianPhone);
    if (existing.length > 0) {
      return { mode: 'LINK', parentId: existing[0].id, relation: r.relation as GuardianRelation };
    }
    return {
      mode: 'CREATE',
      fullName: r.guardianName,
      phone: r.guardianPhone,
      relation: r.relation as GuardianRelation,
      cnic: r.guardianCnic || undefined,
      email: r.guardianEmail || undefined,
    };
  }

  private async currentYearIdOrNull(): Promise<string | null> {
    const y = await this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
    return y?.id ?? null;
  }
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, escaped "", CRLF/LF). Dependency-free. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, ''); // strip BOM (U+FEFF)
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n') {
      record.push(field); records.push(record); record = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) { record.push(field); records.push(record); }

  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ''));
  const header = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { header, rows: nonEmpty };
}
