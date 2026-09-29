import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';
import type { Role, User } from '@prisma/client';
import {
  AppError,
  AuditActions,
  ENV,
  ErrorCodes,
  FIELD_ENCRYPTION,
  FieldEncryption,
  MANDATORY_MFA_ROLES,
  parseSchoolSettings,
  type Env,
  type RequestUser,
  type SchoolSettings,
} from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { doorAllows, type LoginDoor } from './login-door';
import { PasswordService } from './password.service';
import { TokenService, type DecodedAccess } from './token.service';
import { AccessService } from '../access/access.service';
import {
  clearAuthCookies,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from './auth.cookies';
import type {
  ChangePasswordDto,
  DisableMfaDto,
  ForgotPasswordDto,
  LoginDto,
  MfaChallengeDto,
  MfaVerifyDto,
  ResetPasswordDto,
  StudentLoginDto,
} from './dto/auth.dto';

const MAX_FAILED = 10;
const LOCK_MS = 15 * 60 * 1000;
// MANDATORY_MFA_ROLES now lives in @common, shared with MfaEnrolledGuard so login's report and the
// guard's enforcement cannot drift apart.

export interface SessionResult {
  user: { id: string; email: string; roles: Role[]; campusId: string | null };
  mfaEnrollmentRequired?: boolean;
  /** Set when the user got in with a recovery code rather than their authenticator, so the UI
   *  can warn them that one is now spent and how many are left. */
  usedRecoveryCode?: boolean;
  recoveryCodesRemaining?: number;
}
export type LoginResult = SessionResult | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    @Inject(FIELD_ENCRYPTION) private readonly crypto: FieldEncryption,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  /**
   * Which entrance the credentials arrived at (Owner Login Plan). The school owner signs in at
   * `/owner-login`; everyone else at `/login`.
   *
   * ⚠️ **Required, with no default — deliberately.** A default is how this becomes a bypass: a
   * future caller omits the argument and silently authenticates against the permissive door.
   * Required means the compiler asks the question.
   */
  async login(dto: LoginDto, res: Response, door: LoginDoor): Promise<LoginResult> {
    const invalid = () =>
      new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Invalid email or password');

    // `deletedAt: null` is load-bearing, not defensive. The (school_id, email) unique is
    // PARTIAL (WHERE deleted_at IS NULL), so a removed account and a live one may share an
    // address — re-hiring someone is the intended case. An unscoped findFirst is then free to
    // return the REMOVED row, and the deletedAt guard below rejects a perfectly valid password:
    // the re-hired user is silently locked out. Covered by hr-access.e2e-spec.
    const user = await this.db.user.findFirst({ where: { email: dto.email.toLowerCase(), deletedAt: null } });
    // Constant-ish response: never reveal whether the email exists (§22.3). The deletedAt test
    // is now redundant with the query above and stays only so widening that query cannot
    // silently re-admit removed accounts.
    if (!user || user.status === 'DISABLED' || user.deletedAt || !user.passwordHash) {
      // Still spend time hashing to reduce timing signal.
      await this.passwords.verify(
        '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        dto.password,
      );
      throw invalid();
    }

    const now = new Date();
    if (user.status === 'LOCKED') {
      if (user.lockedUntil && user.lockedUntil > now) {
        throw new AppError(ErrorCodes.ACCOUNT_LOCKED, HttpStatus.UNAUTHORIZED, 'Account locked; try later');
      }
      // Lock expired — self-heal before verifying (§22.3).
      //
      // ⚠️ Also outside the request transaction, for two reasons. It must persist even when the
      // very next step rejects the password (otherwise an expired lock never actually clears), and
      // writing it here in the OUTER transaction would leave that row locked while
      // `registerFailure()` below — running in its own transaction — waited for it: a self-deadlock
      // that only unwinds when the transaction budget expires.
      await this.tenantPrisma.outsideRequestTransaction((tx) =>
        tx.user.update({
          where: { id: user.id },
          data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
        }),
      );
      user.failedLoginCount = 0;
      user.status = 'ACTIVE';
    }

    const ok = await this.passwords.verify(user.passwordHash, dto.password);
    if (!ok) {
      await this.registerFailure(user);
      throw invalid();
    }

    // ⚠️ **Placement is the security property, not a style choice.** This sits AFTER the password
    // is verified and BEFORE the MFA hand-off below, and both halves matter:
    //
    //  - After the password, because refusing earlier would answer faster than a wrong password and
    //    the timing alone would reveal who the owner is.
    //  - Before the MFA branch, because that branch issues an `mfaToken`, and `mfaChallenge()`
    //    exchanges a valid one for a **real session** without re-checking anything. A door check
    //    placed after it would not be a leak — it would be a **complete bypass**.
    //
    // The refusal is the same `invalid()` as a wrong password and does the same work: an identical
    // `registerFailure()` write, because skipping it would return measurably sooner and rebuild the
    // oracle the shared error exists to prevent. A "constant response" is only constant if the work
    // behind it is.
    if (!doorAllows(door, user.roles)) {
      await this.registerFailure(user);
      // The only place this event is visible — the caller is told nothing (see LOGIN_WRONG_DOOR),
      // so this row must outlive the rejection that follows it. `AuditService` resolves its client
      // from CLS, so running it inside the helper puts the row in the durable transaction too.
      await this.tenantPrisma.outsideRequestTransaction(() =>
        this.audit.record({
          action: AuditActions.LOGIN_WRONG_DOOR,
          entityType: 'User',
          entityId: user.id,
          actorId: user.id, // no session yet; the password just proved who this is
          newValue: { door, roles: user.roles },
        }),
      );
      throw invalid();
    }

    if (user.failedLoginCount > 0) {
      await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
    }

    if (user.mfaEnabled) {
      return { mfaRequired: true, mfaToken: this.tokens.signMfaPending(user.id, user.schoolId) };
    }

    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    return this.issueSession(user, res);
  }

  /**
   * Count a failed attempt, locking the account at the ceiling (§22.3).
   *
   * ⚠️ **Written OUTSIDE the request transaction, and that is the whole point.** Every caller
   * throws immediately afterwards, and the request transaction rolls back on the way out — so for
   * as long as this used `this.db`, the count was undone by the very rejection it was recording.
   * `failedLoginCount` never rose above 0 and **lockout had never once fired.** Nothing detected it
   * because nothing tested it; the suite covered the arithmetic, never the effect.
   */
  private async registerFailure(user: User): Promise<void> {
    const failed = user.failedLoginCount + 1;
    const data =
      failed >= MAX_FAILED
        ? { failedLoginCount: failed, status: 'LOCKED' as const, lockedUntil: new Date(Date.now() + LOCK_MS) }
        : { failedLoginCount: failed };
    await this.tenantPrisma.outsideRequestTransaction((tx) =>
      tx.user.update({ where: { id: user.id }, data }),
    );
  }

  // ── Student portal login: registration no + CNIC (§28) ──────────────────────
  /**
   * Students sign in with their registration number + CNIC/B-Form (no email/password) —
   * a convenience credential acceptable because the student portal is strictly read-only.
   * The CNIC is compared as a constant-time HMAC against `Student.cnicHash`; failures are
   * rate-limited + lockout-tracked on the linked User; the response is enumeration-safe
   * (same error whether the reg-no, the CNIC, or the account state is the problem).
   */
  async studentLogin(dto: StudentLoginDto, res: Response): Promise<SessionResult> {
    const invalid = () =>
      new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Invalid registration number or CNIC');

    const provided = this.hashCnic(dto.cnic); // always spend the HMAC time (timing-safe)
    const student = await this.db.student.findFirst({
      where: { registrationNo: dto.registrationNo, deletedAt: null, userId: { not: null } },
      select: { userId: true, cnicHash: true },
    });
    if (!student?.userId || !student.cnicHash) throw invalid();

    const user = await this.db.user.findFirst({ where: { id: student.userId } });
    if (!user || user.status === 'DISABLED' || user.deletedAt) throw invalid();

    const now = new Date();
    if (user.status === 'LOCKED') {
      if (user.lockedUntil && user.lockedUntil > now) {
        throw new AppError(ErrorCodes.ACCOUNT_LOCKED, HttpStatus.UNAUTHORIZED, 'Account locked; try later');
      }
      await this.db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null } });
      user.failedLoginCount = 0;
      user.status = 'ACTIVE';
    }

    const stored = student.cnicHash;
    const match = provided.length === stored.length && timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
    if (!match) {
      await this.registerFailure(user);
      throw invalid();
    }

    if (user.failedLoginCount > 0) {
      await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
    }
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    return this.issueSession(user, res);
  }

  /** HMAC of the normalized CNIC/B-Form — matches how the direct-admission flow stores it. */
  private hashCnic(cnic: string): string {
    return createHmac('sha256', this.env.ENCRYPTION_MASTER_KEY).update(cnic.replace(/\D/g, '')).digest('hex');
  }

  // ── MFA challenge (step 2 of two-step login) ────────────────────────────────
  async mfaChallenge(dto: MfaChallengeDto, res: Response): Promise<SessionResult> {
    let sub: string;
    try {
      ({ sub } = this.tokens.verifyMfaPending(dto.mfaToken));
    } catch {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA session expired');
    }
    const user = await this.db.user.findFirst({ where: { id: sub } });
    if (!user || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'MFA not available');
    }
    // A recovery code is accepted in place of the authenticator — this is the whole point of
    // the feature, and it is tried first so a code is consumed rather than rejected as a bad TOTP.
    const usedRecovery = await this.consumeRecoveryCode(user.id, dto.code);
    if (!usedRecovery) {
      const secret = this.crypto.decrypt(user.mfaSecretEnc, user.schoolId);
      if (!authenticator.verify({ token: dto.code, secret })) {
        throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid MFA code');
      }
    }
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const session = await this.issueSession(user, res);
    if (usedRecovery) {
      // Tell them plainly: a code is now spent, and running out means a lockout again.
      const { remaining } = await this.recoveryCodeStatus(user.id);
      return { ...session, usedRecoveryCode: true, recoveryCodesRemaining: remaining };
    }
    return session;
  }

  // ── Session issuance ────────────────────────────────────────────────────────
  private async issueSession(user: User, res: Response): Promise<SessionResult> {
    const claims = { sub: user.id, sid: user.schoolId, roles: user.roles, cid: user.campusId, mfa: user.mfaEnabled };
    const access = this.tokens.signAccess(claims);

    const { raw, hash } = this.tokens.generateRefreshToken();
    const familyId = randomUUID();
    await this.db.refreshToken.create({
      data: {
        schoolId: user.schoolId,
        userId: user.id,
        tokenHash: hash,
        familyId,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
      },
    });

    const csrf = randomBytes(24).toString('base64url');
    setAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
    setRefreshCookie(res, this.env, raw, this.tokens.refreshTtlMs);
    setCsrfCookie(res, this.env, csrf);

    const mfaEnrollmentRequired =
      !user.mfaEnabled && user.roles.some((r) => MANDATORY_MFA_ROLES.includes(r));

    return {
      user: { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId },
      ...(mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
    };
  }

  // ── Refresh rotation (§22.4) ────────────────────────────────────────────────
  async refresh(rawRefresh: string | undefined, res: Response): Promise<SessionResult> {
    const fail = () =>
      new AppError(ErrorCodes.REFRESH_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid refresh token');
    if (!rawRefresh) throw fail();

    const hash = TokenService.hashRefresh(rawRefresh);
    const existing = await this.db.refreshToken.findFirst({ where: { tokenHash: hash } });
    if (!existing) throw fail();

    // Reuse of an already-revoked token => theft signal: revoke the whole family.
    if (existing.revokedAt) {
      await this.db.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn({ userId: existing.userId, familyId: existing.familyId }, 'REFRESH_REUSE_DETECTED');
      throw fail();
    }
    if (existing.expiresAt < new Date()) throw fail();

    const user = await this.db.user.findFirst({ where: { id: existing.userId } });
    if (!user || user.status === 'DISABLED' || user.deletedAt) throw fail();

    // Rotate: revoke the used token, mint a new one in the same family.
    await this.db.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    const { raw, hash: newHash } = this.tokens.generateRefreshToken();
    await this.db.refreshToken.create({
      data: {
        schoolId: user.schoolId,
        userId: user.id,
        tokenHash: newHash,
        familyId: existing.familyId,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
      },
    });

    const access = this.tokens.signAccess({
      sub: user.id,
      sid: user.schoolId,
      roles: user.roles,
      cid: user.campusId,
      mfa: user.mfaEnabled,
    });
    const csrf = randomBytes(24).toString('base64url');
    setAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
    setRefreshCookie(res, this.env, raw, this.tokens.refreshTtlMs);
    setCsrfCookie(res, this.env, csrf);

    return { user: { id: user.id, email: user.email, roles: user.roles, campusId: user.campusId } };
  }

  async logout(rawRefresh: string | undefined, res: Response): Promise<void> {
    if (rawRefresh) {
      const hash = TokenService.hashRefresh(rawRefresh);
      const existing = await this.db.refreshToken.findFirst({ where: { tokenHash: hash } });
      if (existing) {
        await this.db.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    clearAuthCookies(res, this.env);
  }

  // ── Password change / reset ─────────────────────────────────────────────────
  async changePassword(principal: RequestUser, dto: ChangePasswordDto): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user || !user.passwordHash || !(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Current password is wrong');
    }
    if (dto.newPassword.length < 10) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Password too short');
    }
    await this.passwords.isPwned(dto.newPassword); // soft-fail; logged in service
    const hash = await this.passwords.hash(dto.newPassword);
    await this.db.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, passwordChangedAt: new Date() },
    });
    // Revoke all refresh families (§22.3).
    await this.db.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    // Same partial-unique hazard as login: unscoped, this can mint a reset token against a
    // REMOVED account while a live one holds the same address — the user resets a disabled
    // account and still cannot sign in.
    const user = await this.db.user.findFirst({ where: { email: dto.email.toLowerCase(), deletedAt: null } });
    if (user) {
      const raw = randomBytes(32).toString('base64url');
      await this.db.passwordResetToken.create({
        data: {
          schoolId: user.schoolId,
          userId: user.id,
          tokenHash: TokenService.hashRefresh(raw),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      // TODO(M3): dispatch reset link via SMS/email adapter. For now, log for dev only.
      this.logger.debug({ userId: user.id }, 'Password reset token issued (delivery pending M3 comms)');
    }
    // Always 200 — never reveal whether the email exists.
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const hash = TokenService.hashRefresh(dto.token);
    const record = await this.db.passwordResetToken.findFirst({ where: { tokenHash: hash } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid or expired token');
    }
    const newHash = await this.passwords.hash(dto.newPassword);
    await this.db.user.update({
      where: { id: record.userId },
      data: { passwordHash: newHash, passwordChangedAt: new Date(), status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
    await this.db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await this.db.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Set the break-glass access cookie (SA5) from a valid break-glass token, on the tenant host the
   * operator is entering. NO csrf/refresh cookie is issued — the session is read-only (writes are
   * blocked by both the missing csrf and the BreakGlassReadonlyGuard) and simply expires with the
   * token. The token's `sid` confines the session to one school (TenantScopeGuard + RLS, SA-P8).
   */
  async breakGlassEnter(token: string, res: Response): Promise<void> {
    let claims: DecodedAccess;
    try {
      claims = this.tokens.verifyAccess(token);
    } catch {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Invalid or expired link');
    }
    if (!claims.bg) throw new AppError(ErrorCodes.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Not a break-glass link');
    const maxAgeMs = Math.max(0, claims.exp * 1000 - Date.now());
    setAccessCookie(res, this.env, token, maxAgeMs);
  }

  /**
   * Re-sign the ACCESS cookie so its `mfa` claim matches the database right now.
   *
   * ⚠️ Without this, enrolment would not take effect for up to JWT_ACCESS_TTL: an owner who has
   * just set up two-factor tries to reverse a payment and is told to set up two-factor. Disabling
   * has the mirror problem — the token would keep vouching for a second factor that no longer
   * exists. Refresh token and CSRF are untouched; only the claim changed.
   */
  private async resignAccess(userId: string, res: Response): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: userId } });
    if (!user) return;
    const access = this.tokens.signAccess({ sub: user.id, sid: user.schoolId, roles: user.roles, cid: user.campusId, mfa: user.mfaEnabled });
    setAccessCookie(res, this.env, access, this.tokens.accessTtlMs);
  }

  // ── MFA enrolment (§22.5) ───────────────────────────────────────────────────
  async mfaSetup(principal: RequestUser, res: Response): Promise<{ otpauthUrl: string }> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    const secret = authenticator.generateSecret();
    await this.db.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: this.crypto.encrypt(secret, user.schoolId), mfaEnabled: false },
    });
    // Restarting setup turns MFA OFF until the new secret is verified, so the token must stop
    // vouching for enrolment now, not in fifteen minutes.
    await this.resignAccess(user.id, res);
    const otpauthUrl = authenticator.keyuri(user.email, 'SchoolMS', secret);
    return { otpauthUrl };
  }

  async mfaVerify(principal: RequestUser, dto: MfaVerifyDto, res: Response): Promise<{ recoveryCodes: string[] }> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user?.mfaSecretEnc) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Start MFA setup first');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc, user.schoolId);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, 'Invalid MFA code');
    }
    await this.db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await this.resignAccess(user.id, res);
    // Recovery codes are issued WITH enrolment, never as a later opt-in: the moment MFA is on,
    // a lost authenticator is a lockout, and a user who has to remember to generate codes is a
    // user who will not have them when they need them.
    return { recoveryCodes: await this.regenerateRecoveryCodes(user.id) };
  }

  /**
   * Replace this user's recovery codes with a fresh set of ten, returning the PLAINTEXT once.
   *
   * Stored as argon2 hashes exactly like passwords — nothing can read them back afterwards, so
   * the caller must show them immediately or the user has none. Regenerating deletes the old
   * set outright: a half-old, half-new pile is impossible to reason about, and someone
   * regenerating usually does so because they believe the old list is compromised or lost.
   */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => this.newRecoveryCode());
    // Take the tenant from the user row itself rather than request context: these two can never
    // legitimately differ, and reading it here keeps the method callable from any entry point.
    const owner = await this.db.user.findFirst({ where: { id: userId }, select: { schoolId: true } });
    if (!owner) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    const schoolId = owner.schoolId;
    await this.db.mfaRecoveryCode.deleteMany({ where: { userId } });
    for (const code of codes) {
      await this.db.mfaRecoveryCode.create({
        data: { schoolId, userId, codeHash: await this.passwords.hash(this.normalizeRecoveryCode(code)) },
      });
    }
    return codes;
  }

  /** How many codes this user has left — the only thing about them that can ever be READ. */
  async recoveryCodeStatus(userId: string): Promise<{ remaining: number }> {
    return { remaining: await this.db.mfaRecoveryCode.count({ where: { userId, usedAt: null } }) };
  }

  /**
   * Readable, unambiguous codes: no look-alike glyphs (0/O, 1/I/l), grouped for transcription,
   * because these get written on paper and typed back under stress.
   */
  private newRecoveryCode(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
    const block = () => Array.from({ length: 5 }, pick).join('');
    return `${block()}-${block()}`;
  }

  /** Compared case- and dash-insensitively — the user is copying from paper, not a password field. */
  private normalizeRecoveryCode(code: string): string {
    return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
  }

  /**
   * Consume a recovery code, if the supplied value is one. Returns false when it isn't, so the
   * caller can fall through to normal TOTP verification.
   *
   * Every unused code must be checked with argon2 (the hash is deliberately slow and salted, so
   * there is no lookup by value) — 10 verifies is acceptable for a path taken once in a crisis.
   */
  private async consumeRecoveryCode(userId: string, supplied: string): Promise<boolean> {
    const normalized = this.normalizeRecoveryCode(supplied);
    if (normalized.length < 8) return false; // a 6-digit TOTP can never be a recovery code
    const candidates = await this.db.mfaRecoveryCode.findMany({ where: { userId, usedAt: null } });
    for (const c of candidates) {
      if (await this.passwords.verify(c.codeHash, normalized)) {
        // Marked used BEFORE the session is issued, so two concurrent attempts with the same
        // code cannot both succeed.
        await this.db.mfaRecoveryCode.update({ where: { id: c.id }, data: { usedAt: new Date() } });
        return true;
      }
    }
    return false;
  }

  async disableMfa(principal: RequestUser, dto: DisableMfaDto, res: Response): Promise<void> {
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user?.passwordHash || !user.mfaSecretEnc || !(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw new AppError(ErrorCodes.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, 'Password or code invalid');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEnc, user.schoolId);
    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new AppError(ErrorCodes.MFA_INVALID, HttpStatus.UNAUTHORIZED, 'Invalid MFA code');
    }
    await this.db.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    // The codes exist only to recover THIS second factor; leaving them behind would keep a
    // credential alive for an authenticator that no longer exists.
    await this.db.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await this.resignAccess(user.id, res);
  }

  async me(principal: RequestUser): Promise<{ id: string; email: string; name: string | null; roles: Role[]; campusId: string | null; modules: string[]; mfaEnabled: boolean; admissionsMode: SchoolSettings['admissionsMode'] }> {
    // SA5: a break-glass session has no tenant user row — synthesise a read-only "me" so the shell
    // loads (roles come from the token; every write is blocked by the BreakGlassReadonlyGuard).
    if (principal.breakGlass) {
      const bgSchool = await this.db.school.findFirst({ where: { id: principal.schoolId } });
      return {
        id: principal.userId,
        email: 'Vendor support · read-only',
        name: 'Vendor support',
        roles: principal.roles,
        campusId: null,
        modules: [],
        mfaEnabled: false,
        admissionsMode: parseSchoolSettings(bgSchool?.settings).admissionsMode,
      };
    }
    const user = await this.db.user.findFirst({ where: { id: principal.userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'User not found');
    const modules = await this.access.enabledModulesForSelf();
    // The person's display name for the shell greeting — a staff member's own record, so "Ayesha Farooq"
    // instead of the email local-part "teacher1". The owner has no staff profile → null, and the UI falls
    // back to the email prefix.
    const staff = await this.db.staffProfile.findFirst({ where: { userId: user.id }, select: { fullName: true } });
    // Shipped on /auth/me (not a separate fetch) because the UI needs it to decide which
    // admissions surface to render at all — a later fetch would flash the wrong page first.
    const school = await this.db.school.findFirst({ where: { id: principal.schoolId } });
    const { admissionsMode } = parseSchoolSettings(school?.settings);
    // Staff name first (HR owns it); otherwise the account's own name — how an owner gets one (Owner UX Phase 2).
    return { id: user.id, email: user.email, name: staff?.fullName ?? user.fullName ?? null, roles: user.roles, campusId: user.campusId, modules, mfaEnabled: user.mfaEnabled, admissionsMode };
  }

  /**
   * The owner sets their own display name (Owner UX Phase 2). Self-scoped: it can only ever write the
   * caller's row. Staff names are NOT set here — they belong to the HR record (StaffProfile.fullName).
   * An empty string clears it, and the header falls back to the role.
   */
  async setMyName(principal: RequestUser, fullName: string): Promise<{ name: string | null }> {
    const name = fullName.trim().replace(/\s+/g, ' ') || null;
    await this.db.user.update({ where: { id: principal.userId }, data: { fullName: name } });
    return { name };
  }
}
