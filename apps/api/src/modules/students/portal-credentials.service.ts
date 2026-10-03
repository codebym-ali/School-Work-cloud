import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppError, AuditActions, ENV, ErrorCodes, TenantContext, type Env } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { MailerService } from '../mail/mail.service';

@Injectable()
export class PortalCredentialsService {
  private readonly logger = new Logger(PortalCredentialsService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async createCredentials(studentId: string, password: string, confirmPassword: string) {
    if (password !== confirmPassword) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Passwords do not match');
    }

    const { parent } = await this.resolvePrimaryGuardian(studentId);

    if (!parent.email) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Guardian has no email — add email first');
    }
    if (parent.userId) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Portal login already exists for this parent');
    }

    const schoolId = this.ctx.schoolId!;
    const passwordHash = await this.passwords.hash(password);
    const user = await this.db.user.create({
      data: {
        schoolId,
        email: parent.email.toLowerCase(),
        roles: ['PARENT'],
        status: 'ACTIVE',
        passwordHash,
      },
    });
    await this.db.parentProfile.update({
      where: { id: parent.id },
      data: { userId: user.id },
    });

    await this.audit.record({
      action: AuditActions.PARENT_LOGIN_PROVISIONED,
      entityType: 'ParentProfile',
      entityId: parent.id,
      newValue: { studentId, method: 'SET_PASSWORD' },
    });

    return { email: parent.email, message: 'Portal login created' };
  }

  async sendInvite(studentId: string) {
    const { parent } = await this.resolvePrimaryGuardian(studentId);

    if (!parent.email) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Guardian has no email — add email first');
    }
    if (parent.userId) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Portal login already exists for this parent');
    }

    const schoolId = this.ctx.schoolId!;
    const user = await this.db.user.create({
      data: {
        schoolId,
        email: parent.email.toLowerCase(),
        roles: ['PARENT'],
        status: 'MUST_SET_PASSWORD',
      },
    });
    await this.db.parentProfile.update({
      where: { id: parent.id },
      data: { userId: user.id },
    });

    const raw = randomBytes(32).toString('base64url');
    await this.db.passwordResetToken.create({
      data: {
        schoolId,
        userId: user.id,
        tokenHash: TokenService.hashRefresh(raw),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    await this.audit.record({
      action: AuditActions.PARENT_LOGIN_PROVISIONED,
      entityType: 'ParentProfile',
      entityId: parent.id,
      newValue: { studentId, method: 'INVITE_LINK' },
    });

    const setPasswordUrl = `${this.env.PARENT_PORTAL_URL}/set-password?token=${raw}`;
    this.mailer.send({
      to: parent.email,
      subject: 'Set up your parent portal account',
      text: `Your school has created a parent portal account for you. Click this link to set your password (expires in 48 hours):\n\n${setPasswordUrl}\n\nOnce set, you can log in to view your child's attendance, results, and fees.`,
      html: `<p>Your school has created a parent portal account for you.</p><p>Click the link below to set your password (expires in 48 hours):</p><p><a href="${setPasswordUrl}">${setPasswordUrl}</a></p><p>Once set, you can log in to view your child's attendance, results, and fees.</p>`,
    }).catch((err) => this.logger.error({ err, email: parent.email }, 'Failed to send portal invite email'));
    this.logger.debug({ email: parent.email, userId: user.id }, 'Parent portal invite link generated');

    return { email: parent.email, message: 'Invite email sent', token: raw };
  }

  async resetPassword(studentId: string, guardianId: string, body: { password?: string; sendLink?: boolean }) {
    const guardian = await this.db.studentGuardian.findFirst({
      where: { id: guardianId, studentId },
      include: { parent: { select: { id: true, email: true, userId: true, fullName: true } } },
    });
    if (!guardian) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Guardian not found');
    }
    if (!guardian.parent.userId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Portal login does not exist for this parent');
    }

    const userId = guardian.parent.userId;

    if (body.sendLink) {
      const raw = randomBytes(32).toString('base64url');
      await this.db.passwordResetToken.create({
        data: {
          schoolId: this.ctx.schoolId!,
          userId,
          tokenHash: TokenService.hashRefresh(raw),
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        },
      });
      await this.db.user.update({
        where: { id: userId },
        data: { status: 'MUST_SET_PASSWORD' },
      });
      if (guardian.parent.email) {
        const resetUrl = `${this.env.PARENT_PORTAL_URL}/set-password?token=${raw}`;
        this.mailer.send({
          to: guardian.parent.email,
          subject: 'Reset your parent portal password',
          text: `Your school has reset your parent portal password. Click this link to set a new password (expires in 48 hours):\n\n${resetUrl}`,
          html: `<p>Your school has reset your parent portal password.</p><p>Click the link below to set a new password (expires in 48 hours):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
        }).catch((err) => this.logger.error({ err, email: guardian.parent.email }, 'Failed to send portal reset email'));
      }
      this.logger.debug({ email: guardian.parent.email, userId }, 'Parent portal reset link generated');
    } else if (body.password) {
      const passwordHash = await this.passwords.hash(body.password);
      await this.db.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
      });
      await this.db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Provide password or sendLink');
    }

    await this.audit.record({
      action: AuditActions.PARENT_PASSWORD_RESET,
      entityType: 'ParentProfile',
      entityId: guardian.parent.id,
      newValue: { method: body.sendLink ? 'SEND_LINK' : 'SET_PASSWORD', resetBy: this.ctx.user?.userId },
    });

    return { ok: true };
  }

  async portalStatus(studentId: string) {
    const guardians = await this.db.studentGuardian.findMany({
      where: { studentId },
      include: {
        parent: {
          select: { id: true, fullName: true, email: true, userId: true },
        },
      },
      orderBy: { isPrimary: 'desc' },
    });

    return guardians.map((g) => {
      let status: 'active' | 'invited' | 'no_access';
      if (!g.parent.userId) {
        status = g.parent.email ? 'no_access' : 'no_access';
      } else {
        status = 'active';
      }
      return {
        guardianId: g.id,
        parentId: g.parent.id,
        fullName: g.parent.fullName,
        email: g.parent.email,
        relation: g.relation,
        isPrimary: g.isPrimary,
        portalStatus: status,
        hasEmail: !!g.parent.email,
      };
    });
  }

  private async resolvePrimaryGuardian(studentId: string) {
    const student = await this.db.student.findFirst({
      where: { id: studentId, deletedAt: null },
      select: { id: true, fullName: true },
    });
    if (!student) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    }

    const guardian = await this.db.studentGuardian.findFirst({
      where: { studentId, isPrimary: true },
      include: {
        parent: { select: { id: true, email: true, userId: true, fullName: true } },
      },
    });
    if (!guardian) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No primary guardian found');
    }

    return { parent: guardian.parent, student };
  }
}
