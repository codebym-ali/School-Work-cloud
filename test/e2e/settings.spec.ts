import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet } from './helpers';

interface Settings {
  weeklyOffDays: string[];
  feeDueDay: number;
  staffAttendance: { selfMarking: boolean; dayStartTime: string; graceMinutes: number };
}

/**
 * The school settings screen.
 *
 * Its whole reason to exist is that these values previously required a developer with database
 * access, so the test that matters is not "the form renders" but "a change made here is really
 * stored, and it does not disturb anything else".
 */
test.describe('school settings', () => {
  test('a change saves, takes effect, and leaves the other settings alone', async ({ page }) => {
    await gotoApp(page, '/settings');
    await expect(page.getByRole('heading', { name: 'School settings' })).toBeVisible();

    const before = await apiSetupGet<Settings>(page, '/school-settings');

    try {
      // The setting that prompted this screen: a 19:18 check-in read as "late" against an
      // 08:00 default that nobody could see, let alone change.
      const start = page.locator('input[type="time"]').first();
      await start.fill('09:30');
      await start.blur();
      await expect(page.locator('.toast.ok')).toContainText('Saved');

      // Stored, not merely rendered.
      const after = await apiSetupGet<Settings>(page, '/school-settings');
      expect(after.staffAttendance.dayStartTime).toBe('09:30');

      // ...and the merge did not reset its neighbours. This is the defect the DTO's
      // materialised `undefined` keys caused, so it is asserted rather than assumed.
      expect(after.staffAttendance.selfMarking).toBe(before.staffAttendance.selfMarking);
      expect(after.staffAttendance.graceMinutes).toBe(before.staffAttendance.graceMinutes);
      expect(after.feeDueDay).toBe(before.feeDueDay);
      expect(after.weeklyOffDays).toEqual(before.weeklyOffDays);

      // The consequence is stated in the school's own words, not as a field name.
      await expect(page.getByText(/checking in after/i)).toContainText('09:45');
    } finally {
      await page.locator('input[type="time"]').first().fill(before.staffAttendance.dayStartTime);
      await page.locator('input[type="time"]').first().blur();
      await expect(page.locator('.toast.ok')).toContainText('Saved');
      const restored = await apiSetupGet<Settings>(page, '/school-settings');
      expect(restored.staffAttendance.dayStartTime).toBe(before.staffAttendance.dayStartTime);
    }
  });
});
