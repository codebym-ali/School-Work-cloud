import type { PlanTier } from '@prisma/client';
import { PLAN_MONTHLY_SMS_CREDITS } from '../comms/sms/sms-plan-credits';

/**
 * The per-plan entitlement catalog (SA3). Limits are DEFINED here — one server-side source (Law 4),
 * keyed by `PlanTier`, the same shape as `PLAN_MONTHLY_SMS_CREDITS` (which stays the single source
 * for SMS credits; referenced here, not duplicated). These are the initial figures for the Pakistani
 * private-school market; the vendor tunes them here — a code change, matching the SMS-credit
 * precedent (a DB-backed catalog can come later if per-plan tuning without a deploy is ever needed).
 *
 * ⚠️ SA3a EXPOSES the catalog and ASSIGNS a plan to a school. It does NOT enforce the caps on the
 * tenant request path — that is SA3b (the atomic count-vs-cap checks on admission / staff / storage).
 */
export interface PlanLimits {
  maxStudents: number;
  maxStaff: number;
  maxCampuses: number;
  storageMb: number;
  monthlySmsCredits: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  BASIC: { maxStudents: 500, maxStaff: 50, maxCampuses: 1, storageMb: 2_000, monthlySmsCredits: PLAN_MONTHLY_SMS_CREDITS.BASIC },
  PLUS: { maxStudents: 1_500, maxStaff: 150, maxCampuses: 3, storageMb: 10_000, monthlySmsCredits: PLAN_MONTHLY_SMS_CREDITS.PLUS },
  PRO: { maxStudents: 6_000, maxStaff: 500, maxCampuses: 10, storageMb: 50_000, monthlySmsCredits: PLAN_MONTHLY_SMS_CREDITS.PRO },
};

/** The plan tiers, in ascending order — for UI selectors and validation. */
export const PLAN_TIERS = Object.keys(PLAN_LIMITS) as PlanTier[];
