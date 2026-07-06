import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppError, ErrorCodes, parseSchoolSettings } from '@common';
import { PlatformPrismaService } from '@database';
import { DEFAULT_TEMPLATES, SMS_TRIGGER_KEYS } from '../comms/sms/sms-templates.defaults';

// Monthly included SMS credits per plan tier (blueprint §14).
const PLAN_CREDITS = { BASIC: 1000, PLUS: 5000, PRO: 20000 } as const;

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
}

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

    // Seed default SMS templates and the plan's monthly credit grant (§14).
    await this.platform.smsTemplate.createMany({
      data: SMS_TRIGGER_KEYS.map((k) => ({ schoolId: school.id, triggerKey: k, body: DEFAULT_TEMPLATES[k] })),
    });
    await this.platform.smsCreditLedger.create({
      data: { schoolId: school.id, delta: PLAN_CREDITS.BASIC, refType: 'PLAN_MONTHLY' },
    });

    return { schoolId: school.id, campusId: campus.id, ownerUserId: owner.id };
  }
}
