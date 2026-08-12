import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent } from './helpers';

/**
 * Runs the Class strength report (no params, so deterministic) and asserts the rendered
 * table, then verifies the CSV export endpoint responds with CSV. Seeds a fresh enrolled
 * student first so there is at least one row regardless of other data.
 */
test.describe('reports', () => {
  test('class-strength renders a table and CSV export works', async ({ page }) => {
    await gotoApp(page);
    await seedClassSectionStudent(page, { name: 'E2E Reports' });

    await page.getByRole('link', { name: 'Reports', exact: true }).click();
    await page.waitForURL('**/reports');

    // Class strength is the screen's default selection; run it.
    await page.locator('label:text-is("Report") + select').selectOption('class-strength');
    await page.getByRole('button', { name: 'View' }).click();

    const table = page.locator('table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead')).toContainText('activeStudents');
    await expect(table.locator('tbody tr').first()).toBeVisible();

    // CSV export: the anchor points at the report endpoint with format=csv; fetch it.
    const csvLink = page.getByRole('link', { name: 'Download CSV' });
    const href = await csvLink.getAttribute('href');
    expect(href).toContain('/reports/class-strength');
    expect(href).toContain('format=csv');

    const res = await page.request.get(`http://localhost:3001${href}`);
    expect(res.ok()).toBe(true);
    const ctype = res.headers()['content-type'] ?? '';
    expect(ctype).toContain('csv');
    // CSV header row should name the columns the JSON view showed.
    expect(await res.text()).toContain('activeStudents');
  });
});
