import { z } from 'zod';

/**
 * Typed validation for the School.settings JSON blob (blueprint §17.1 item 5).
 * Unknown keys are rejected; defaults are the blueprint's documented §9–§13 values.
 */
export const WeekDay = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

export const schoolSettingsSchema = z
  .object({
    attendanceSessions: z
      .array(z.enum(['MORNING', 'EVENING']))
      .min(1)
      .default(['MORNING']),
    weeklyOffDays: z.array(WeekDay).default(['SUNDAY']),
    attendanceEditWindowDays: z.number().int().min(0).default(3),
    allowHolidayOverride: z.boolean().default(false),
    feeDueDay: z.number().int().min(1).max(28).default(10),
    midMonthProration: z.enum(['FULL', 'HALF', 'DAILY']).default('FULL'),
    siblingDiscountPercent: z.number().min(0).max(100).default(0),
    sectionCapacityMode: z.enum(['HARD', 'ADVISORY']).default('ADVISORY'),
    promotionRequiresFeeClearance: z.boolean().default(true),
    smsOverdraftSegments: z.number().int().min(0).default(100),
    staffLeaveQuotas: z
      .object({
        CASUAL: z.number().int().min(0),
        SICK: z.number().int().min(0),
        UNPAID: z.number().int().min(0),
        OTHER: z.number().int().min(0),
      })
      .partial()
      .default({ CASUAL: 10, SICK: 8 }),
  })
  .strict(); // reject unknown keys (§17.1)

export type SchoolSettings = z.infer<typeof schoolSettingsSchema>;

/** Parse a raw settings blob, applying defaults. Throws on unknown/invalid keys. */
export function parseSchoolSettings(raw: unknown): SchoolSettings {
  return schoolSettingsSchema.parse(raw ?? {});
}
