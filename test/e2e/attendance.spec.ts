import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent, safeAttendanceDate } from './helpers';

/**
 * Marks attendance for a fresh, self-contained class/section/student on a valid past,
 * non-weekly-off date (backend rejects future dates and unoverridden weekly-off days — the
 * helper reads the school's OWN `weeklyOffDays`, because this tenant keeps Saturday off too and
 * assuming Sunday made this spec fail every Saturday). Asserts the save succeeded, that the posted bulk
 * payload carries the chosen status (a value that's easy to drop — see the exams
 * marks-entry race we fixed), and that the status persists on roster reload.
 */
test.describe('attendance', () => {
  test('mark a student LATE on a valid date, persisted on reload', async ({ page }) => {
    await gotoApp(page);
    const { className, sectionName, studentName } = await seedClassSectionStudent(page, { name: 'E2E Attendance' });

    await page.getByRole('link', { name: 'Attendance', exact: true }).click();
    await page.waitForURL('**/attendance');

    // Pick the fresh section (label is "<class> — <section>") and a safe date.
    await page.locator('label:text-is("Section") + select').selectOption({ label: `${className} — ${sectionName}` });

    // ⚠️ **Two rules meet here, and on a weekly off they leave no legal date at all.**
    // `StudentEnrollment.startedAt` is `@default(now())` and admission takes no override, so a
    // freshly seeded student is enrolled from TODAY. The register separately refuses any date the
    // enrolment was not active on — deliberately, so backfilling a week cannot invent a record for
    // a child who had not joined. So the only date this fixture can ever be marked on is today,
    // and when today is a weekly off or a closure there is none.
    // Skipping says that; marking with `allowHolidayOverride` would quietly convert this into a
    // test of the override path, which is a different claim and is covered elsewhere.
    const date = await safeAttendanceDate(page);
    const today = new Date().toISOString().slice(0, 10);
    test.skip(
      date !== today,
      `today (${today}) is a non-working day, and the newest markable day (${date}) predates this ` +
      `fixture's enrolment — students are enrolled from today and cannot be marked before that`,
    );
    await page.locator('label:text-is("Date") + input').fill(date);
    await page.getByRole('button', { name: 'Load roster' }).click();

    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    // ⚠️ The register is four buttons, not a `<select>` — M2 replaced it on 2026-08-09 so a
    // teacher marks a child in ONE tap instead of opening a modal wheel on a phone. This spec kept
    // driving the select and had been red ever since: a suite carrying a known red cannot judge
    // the next change, which is exactly when a real regression walks in unnoticed. Same shape as
    // `classes-ux` sitting red after "Setup" was renamed "School configuration".
    // Driven by `aria-label`, the accessible name, rather than the "L" glyph — so the letters can
    // be restyled without breaking this, and a missing label fails here rather than silently on a
    // screen reader.
    await row.getByRole('button', { name: 'Late', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Late', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Assert the bulk payload actually carries LATE for this student's enrollment.
    const bulkReq = page.waitForRequest((r) => r.url().includes('/attendance/bulk') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Save attendance' }).click();
    const posted = (await (await bulkReq).postDataJSON()).records as Array<{ status: string }>;
    expect(posted.some((r) => r.status === 'LATE')).toBe(true);
    await expect(page.locator('.toast.ok')).toContainText('Saved 1, failed 0');

    // Reload the roster: the saved status must round-trip back onto the button. `aria-pressed` is
    // the assertion because it is what a screen reader reads AND what the eye sees highlighted —
    // checking a CSS class would pass on a register that announces nothing.
    await page.getByRole('button', { name: 'Load roster' }).click();
    const rowAfter = page.locator('tbody tr', { hasText: studentName });
    await expect(rowAfter.getByRole('button', { name: 'Late', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
