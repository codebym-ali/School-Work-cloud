import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent, safeAttendanceDate } from './helpers';

/**
 * Marks attendance for a fresh, self-contained class/section/student on a valid past,
 * non-weekly-off date (backend rejects future dates and unoverridden weekly-off days —
 * default weekly-off is SUNDAY). Asserts the save succeeded, that the posted bulk
 * payload carries the chosen status (a value that's easy to drop — see the exams
 * marks-entry race we fixed), and that the status persists on roster reload.
 */
test.describe('attendance', () => {
  test('mark a student LATE on a valid date, persisted on reload', async ({ page }) => {
    await gotoApp(page);
    const { className, sectionName, studentName } = await seedClassSectionStudent(page);

    await page.getByRole('link', { name: 'Attendance', exact: true }).click();
    await page.waitForURL('**/attendance');

    // Pick the fresh section (label is "<class> — <section>") and a safe date.
    await page.locator('label:text-is("Section") + select').selectOption({ label: `${className} — ${sectionName}` });
    await page.locator('label:text-is("Date") + input').fill(safeAttendanceDate());
    await page.getByRole('button', { name: 'Load roster' }).click();

    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    await row.locator('select').selectOption('LATE');

    // Assert the bulk payload actually carries LATE for this student's enrollment.
    const bulkReq = page.waitForRequest((r) => r.url().includes('/attendance/bulk') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Save attendance' }).click();
    const posted = (await (await bulkReq).postDataJSON()).records as Array<{ status: string }>;
    expect(posted.some((r) => r.status === 'LATE')).toBe(true);
    await expect(page.locator('.toast.ok')).toContainText('Saved 1, failed 0');

    // Reload the roster: the saved status must round-trip back into the select.
    await page.getByRole('button', { name: 'Load roster' }).click();
    const rowAfter = page.locator('tbody tr', { hasText: studentName });
    await expect(rowAfter.locator('select')).toHaveValue('LATE');
  });
});
