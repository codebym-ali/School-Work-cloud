import { PlanTier } from '@prisma/client';

/**
 * Monthly included SMS credits (segments) per plan tier (blueprint §14). Granted at
 * provisioning (ProvisioningService) and refreshed on the 1st of each month by the
 * `sms-monthly-credit` maintenance job (MaintenanceService).
 */
export const PLAN_MONTHLY_SMS_CREDITS: Record<PlanTier, number> = {
  BASIC: 1000,
  PLUS: 5000,
  PRO: 20000,
};
