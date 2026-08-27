import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { AppError, ErrorCodes, parseSchoolSettings } from '@common';
import { PlatformPrismaService } from '@database';
import { TokenService } from '../auth/token.service';
import { DEFAULT_TEMPLATES, SMS_TRIGGER_KEYS } from '../comms/sms/sms-templates.defaults';
import { PLAN_MONTHLY_SMS_CREDITS } from '../comms/sms/sms-plan-credits';

export interface ProvisionInput {
  name: string;
  subdomain: string;
  ownerEmail: string;
  /** If provided, the owner is created ACTIVE; otherwise INVITED (set-password flow). */
  ownerPassword?: string;
  firstCampusName?: string;
}

export interface ProvisionResult {
  schoolId: string;
  campusId: string;
  ownerUserId: string;
  /** A one-time onboarding token (SA2, SA-P3) — present only when the owner was created INVITED
   *  (no password). The owner sets their own password via /auth/reset-password; never shown again. */
  onboardingToken?: string;
}

/** How long a provisioning onboarding link stays valid. Deliberately LONGER than the 30-min
 *  password-reset TTL: onboarding is not urgent self-service — the operator delivers the link and the
 *  new owner may act hours or a day later. Single-use and hashed, so a wide window is acceptable. */
const ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tenant provisioning (blueprint §24 vendor console `POST /platform/schools`).
 * Cross-tenant, so it runs on the BYPASSRLS platform client (§21.5): creates the
 * School with validated default settings, the first Campus, and the OWNER_ADMIN.
 *
 * NOTE: the vendor-console HTTP surface + PLATFORM_ADMIN auth is a dedicated
 * platform milestone; for now this service is the bootstrap used by the dev seed
 * and the M2 tests. Default SMS templates are seeded in M3 (comms).
 */
@Injectable()
export class ProvisioningService {
  constructor(private readonly platform: PlatformPrismaService) {}

  async provisionSchool(input: ProvisionInput): Promise<ProvisionResult> {
    const subdomain = input.subdomain.toLowerCase();
    const existing = await this.platform.school.findFirst({ where: { subdomain } });
    if (existing) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Subdomain already taken');
    }

    // Validate/normalize default settings up-front (§17.1) so no tenant starts invalid.
    const settings = parseSchoolSettings({});

    const school = await this.platform.school.create({
      data: { name: input.name, subdomain, settings: settings as never },
    });
    const campus = await this.platform.campus.create({
      data: { schoolId: school.id, name: input.firstCampusName ?? 'Main Campus' },
    });
    const owner = await this.platform.user.create({
      data: {
        schoolId: school.id,
        email: input.ownerEmail.toLowerCase(),
        roles: ['OWNER_ADMIN'],
        passwordHash: input.ownerPassword
          ? await argon2.hash(input.ownerPassword, { type: argon2.argon2id })
          : null,
        status: input.ownerPassword ? 'ACTIVE' : 'INVITED',
      },
    });

    // SA2 (SA-P3): when no password was supplied (the vendor console never sends one), the owner is
    // INVITED and gets a one-time onboarding token instead — the SAME `password_reset_tokens` the
    // forgot-password flow uses, minted here on the BYPASSRLS connection for the just-created tenant.
    // The owner sets their own password via /auth/reset-password (which also flips INVITED → ACTIVE).
    // The raw token is returned to the caller ONCE; only its SHA-256 hash is stored.
    let onboardingToken: string | undefined;
    if (!input.ownerPassword) {
      const raw = randomBytes(32).toString('base64url');
      await this.platform.passwordResetToken.create({
        data: {
          schoolId: school.id,
          userId: owner.id,
          tokenHash: TokenService.hashRefresh(raw),
          expiresAt: new Date(Date.now() + ONBOARDING_TTL_MS),
        },
      });
      onboardingToken = raw;
    }

    // Seed default SMS templates and the plan's monthly credit grant (§14).
    await this.platform.smsTemplate.createMany({
      data: SMS_TRIGGER_KEYS.map((k) => ({ schoolId: school.id, triggerKey: k, body: DEFAULT_TEMPLATES[k] })),
    });
    await this.platform.smsCreditLedger.create({
      data: { schoolId: school.id, delta: PLAN_MONTHLY_SMS_CREDITS.BASIC, refType: 'PLAN_MONTHLY' },
    });

    return { schoolId: school.id, campusId: campus.id, ownerUserId: owner.id, onboardingToken };
  }
}
