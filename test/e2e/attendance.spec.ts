import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent } from './helpers';

/**
 * The OWNER's attendance screen is READ-ONLY (Owner UX Remediation Plan, Phase 0.1, 2026-09-29).
 *
 * Marking a register is the class teacher's job; campus admin and the Ops Admin make corrections. An owner
 * rewriting a child's attendance — which texts parents and becomes the child's record — blurs who is
 * accountable for it, so the API refuses the owner (403) and this screen must not offer the controls.
 * Marking itself is covered as a TEACHER in `qa/09-teacher-attendance.spec.ts`.
 *
 * This spec used to mark a student LATE *as the owner*; it now pins the opposite, so a regression that
 * hands the owner the register again goes red here, not in a parent's inbox.
 */
test.describe('attendance (owner view)', () => {
  test('the owner sees a read-only register — no marking controls, unmarked shown truthfully', async ({ page }) => {
    await gotoApp(page);
    const { className, sectionName, studentName } = await seedClassSectionStudent(page, { name: 'E2E Attendance' });

    await page.getByRole('link', { name: 'Attendance', exact: true }).click();
    await page.waitForURL('**/attendance');
    await expect(page.getByText('View only. Class teachers mark attendance', { exact: false })).toBeVisible();

    // Selecting a section loads the register directly — there is no "Load roster" step for a viewer.
    await page.locator('label:text-is("Section") + select').selectOption({ label: `${className} — ${sectionName}` });
    await expect(page.getByRole('button', { name: 'Load roster' })).toHaveCount(0);

    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    // A fresh student has no record today, so the register says so — it never assumes "Present".
    await expect(row).toContainText('Not marked');
    // No P / A / L / ½ buttons, and nothing to save.
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save attendance' })).toHaveCount(0);
  });
});
