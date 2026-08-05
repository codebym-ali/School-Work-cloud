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

/**
 * An IANA zone name (`Asia/Karachi`, `Asia/Dubai`). Validated by asking the runtime to use it,
 * because the list is data that ships with ICU and changes — hardcoding an allowlist here would
 * be wrong within a year, and a zone the server cannot resolve is worse than a rejected one.
 */
const IanaTimeZone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be an IANA time zone name, e.g. Asia/Karachi' },
);

export const schoolSettingsSchema = z
  .object({
    /**
     * The school's own wall clock (G4).
     *
     * Every "what time is it" question in the product used to read the SERVER's clock, which is
     * correct only while every tenant is a Pakistani school on one box — and wrong *silently* the
     * moment one is not. Three rules turn on it: whether a check-in is LATE, whether the staff
     * day close is due, and whether a class register is overdue. All three now ask the school.
     *
     * Defaults to Asia/Karachi, which is what the fleet was implicitly assuming, so no existing
     * school's behaviour changes.
     *
     * ⚠️ Scope: this fixes the **clock comparisons**. Date columns are still UTC-midnight
     * (`@db.Date`), so "which day a record belongs to" is unchanged — see the note in G4.
     */
    timezone: IanaTimeZone.default('Asia/Karachi'),
    attendanceSessions: z
      .array(z.enum(['MORNING', 'EVENING']))
      .min(1)
      .default(['MORNING']),
    weeklyOffDays: z.array(WeekDay).default(['SUNDAY']),
    attendanceEditWindowDays: z.number().int().min(0).default(3),
    /**
     * How many days back a TEACHER may create attendance for (0 = today only). Distinct from
     * `attendanceEditWindowDays`, which governs CHANGING a record that already exists — this
     * governs filling in a day that was never marked, e.g. after a teacher was off sick.
     *
     * Previously unbounded: `markBulk` rejected only future dates, so attendance could be
     * created for any date in history. Attendance drives payroll deductions and defaulter
     * reporting, so it needs a floor. Admins remain unlimited (audited).
     */
    attendanceBackfillDays: z.number().int().min(0).max(90).default(7),
    /**
     * Local wall-clock time by which each section's register is expected to be marked (G3).
     *
     * **It surfaces; it does not police.** Nothing is blocked after it, nobody is punished, and
     * no attendance is derived — an unmarked day stays an honest gap for ever, because "nobody
     * said" is not "absent" and absence SMS goes to real parents. All it decides is *when the
     * head is shown the gap*: before this time a blank register is simply a lesson that hasn't
     * happened yet, and complaining then trains people to ignore the complaint.
     *
     * Default 10:00 — after a normal first period, well before the day ends.
     */
    attendanceMarkByTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('10:00'),
    allowHolidayOverride: z.boolean().default(false),
    feeDueDay: z.number().int().min(1).max(28).default(10),
    midMonthProration: z.enum(['FULL', 'HALF', 'DAILY']).default('FULL'),
    siblingDiscountPercent: z.number().min(0).max(100).default(0),
    sectionCapacityMode: z.enum(['HARD', 'ADVISORY']).default('ADVISORY'),
    // How the school takes admissions (§8). DIRECT = the front desk fills one form and the
    // student is admitted on the spot; the inquiry pipeline (lead → entry test → admit) is
    // hidden. PIPELINE = the school tracks enquiries and runs entry tests before admitting.
    // Default DIRECT: most schools admit anyone who can pay, and an enquiry register that
    // nobody fills in makes the conversion metrics fiction. Note every metric in
    // `/inquiries/summary` counts Inquiry rows, so they read 0 for a DIRECT school by design.
    admissionsMode: z.enum(['DIRECT', 'PIPELINE']).default('DIRECT'),
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
    /**
     * Staff attendance (§9/§13). Every switch defaults OFF, so no existing school changes
     * behaviour on deploy — these govern how staff attendance is *recorded*, and it feeds the
     * payroll attendance deduction.
     *
     * `selfMarking` lets a staff member assert their own PRESENCE for today. It is never
     * absence, never a past date, and the status is derived from the clock rather than chosen
     * — otherwise a teacher would be setting their own salary deduction.
     *
     * `autoMarkAbsent` (the day-close job) is DEFINED BUT NOT YET IMPLEMENTED — deliberately
     * deferred, because a job that silently creates salary deductions before a school trusts
     * the register is how the register stops being trusted. Until it exists, an ABSENT row
     * only appears where a human put it, and screens lead with "not marked" rather than
     * presenting an absent count over a half-kept register as fact.
     */
    /**
     * How this school takes money (§12). Schools differ enormously here: a one-branch school
     * collects cash over the counter and must not be shown wallet references and challan
     * numbers it will never use, while a larger one runs bank transfer, JazzCash and EasyPaisa
     * side by side.
     *
     * **`methods` is enforced in the service, not just hidden in the UI** — a method the school
     * does not accept is refused by `pay()`. Hiding alone would be a display gate over an open
     * endpoint. Switching one off governs only NEW payments: money already taken by cheque
     * stays readable, reversible and on its receipt.
     *
     * Deliberately absent: any switch that would let a claimed payment auto-verify. That is a
     * correctness rule, not a preference — a settings screen must not offer a toggle whose
     * "off" position is a defect.
     */
    feeSubmission: z
      .object({
        /** Cash-only is the honest default for a new school; it grows into the rest. */
        methods: z
          .array(z.enum(['CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CHEQUE', 'CARD']))
          .min(1, 'Accept at least one payment method')
          .default(['CASH']),
        /** Whether a screenshot / challan counterfoil is attached to a non-cash payment. */
        proofPolicy: z.enum(['OFF', 'OPTIONAL', 'REQUIRED']).default('OPTIONAL'),
        /** Guardians upload proof from a link in the fee SMS — no account, no portal. */
        guardianUploadLink: z.boolean().default(false),
        /** Days a cheque is held before it counts as money — a cheque is not money until it clears. */
        chequeClearingDays: z.number().int().min(0).max(30).default(3),
      })
      .default({}),
    staffAttendance: z
      .object({
        selfMarking: z.boolean().default(false),
        autoMarkAbsent: z.boolean().default(false),
        /** Local wall-clock start of the working day, HH:MM. */
        dayStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
        /** Minutes after `dayStartTime` still counted as on time. */
        graceMinutes: z.number().int().min(0).max(120).default(15),
        /**
         * Local wall-clock time the register is settled, HH:MM. After this, `autoMarkAbsent`
         * gives every unmarked staff member a status and the day is closed.
         *
         * Was hardcoded fleet-wide at 20:00 in the server's timezone (G2). Two consequences,
         * both real: a morning school ending at 13:00 had its absences settled seven hours
         * later, and — worse — **a teacher arriving after the close could not check in at all**,
         * because their ABSENT row already existed and check-in refuses to overwrite a
         * recorded status. With one fleet-wide time, some school always has this backwards.
         *
         * Kept at the old 20:00 as the default so no school's behaviour changes on upgrade.
         */
        closeAtTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('20:00'),
      })
      .default({}),
  })
  .strict(); // reject unknown keys (§17.1)

export type SchoolSettings = z.infer<typeof schoolSettingsSchema>;

/** Parse a raw settings blob, applying defaults. Throws on unknown/invalid keys. */
export function parseSchoolSettings(raw: unknown): SchoolSettings {
  return schoolSettingsSchema.parse(raw ?? {});
}
