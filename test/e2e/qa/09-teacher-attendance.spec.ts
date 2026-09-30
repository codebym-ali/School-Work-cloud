import { test, expect } from '@playwright/test';
import { signIn, world } from './qa-world';

/**
 * C9 — the teacher attendance-picker (Live Click-Through Test Plan; the §2 gap that needed a teacher
 * session). A teacher sees ONLY the sections they are assigned to mark (the picker is fed by
 * `/teaching/my-classes`, i.e. their TeacherAssignments — not the school-wide list), and marking a
 * register persists. The server enforces the scoping too (WS-E, §22.8); this proves the UI mirrors it,
 * so a teacher never even sees a section that would 403 on save.
 */
test('C9 — a teacher can pick only their assigned section and mark its register', async ({ browser }) => {
  const w = world();
  const { page, context } = await signIn(browser, 'teacher');
  try {
    await page.goto('/attendance');

    // The section picker is fed by the teacher's own assignments (`/teaching/my-classes`), which loads
    // asynchronously. Wait for the options to settle: a placeholder + EXACTLY the one assigned section.
    // The count itself is the scoping assertion — a teacher never gets the school's several sections.
    const picker = page.getByLabel('Section');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveCount(2);
    const options = await picker
      .locator('option')
      .evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()).filter(Boolean));
    expect(options.filter((o) => o !== 'Choose a section…' && o !== '')).toEqual([w.teacherSection.label]);

    // Load the roster and mark it. A fresh section has no prior marks, so the save is clean (no
    // authorship conflict), and the bulk endpoint answers 200.
    await picker.selectOption({ label: w.teacherSection.label });
    await page.getByRole('button', { name: /load roster/i }).click();
    const save = page.getByRole('button', { name: 'Save attendance' });
    await expect(save).toBeVisible();

    const saved = page.waitForResponse((r) => r.url().includes('/attendance/bulk') && r.request().method() === 'POST');
    await save.click();
    expect((await saved).status()).toBe(200);
  } finally {
    await context.close();
  }
});
