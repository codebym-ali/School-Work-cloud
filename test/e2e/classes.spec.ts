import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, apiSetupGet, apiSetupPost, seedClassSection } from './helpers';

/**
 * The Classes register and the class workbench.
 *
 * Covers the two capabilities that shipped in the API months ago and had NO caller in the UI,
 * so neither could be reached at all:
 *  - changing which subjects a section studies (`PUT /sections/:id/subjects`)
 *  - renaming a subject (`PATCH /subjects/:id`)
 *
 * ...plus the teaching tags, which are what the list is for: "who teaches 9-A Maths?" could
 * previously only be answered by opening every teacher in the staff directory.
 *
 * Deliberately needs no student, so it runs without an admission officer (see
 * `seedClassSectionStudent`). It cleans up its own class at the end.
 */
test.describe('classes', () => {
  test('class card shows teaching tags; workbench renames a subject and re-picks a section’s subjects', async ({ page }) => {
    await gotoApp(page);
    const seeded = await seedClassSection(page);
    const { className, sectionName, classId, sectionId, subjectName } = seeded;
    const secondSubject = `Extra${Date.now()}`;

    try {
      // ── The register ────────────────────────────────────────────────────────
      await page.goto('/classes');
      // Filter by the card's TITLE LINK, not by text: the "Copy subjects from" dropdown on the
      // add-class form lists every class name, so `hasText` matches that card first.
      const card = page.locator('.card').filter({ has: page.getByRole('link', { name: className, exact: true }) });
      await expect(card).toBeVisible();

      // A class with a section and a subject is admission-ready...
      await expect(card).toContainText('Ready to admit');
      // ...but nobody teaches that subject yet, so the tag reads unassigned. This is the
      // question the screen could not answer before.
      await expect(card).toContainText(`${subjectName} · unassigned`);
      await expect(card).toContainText('1 subject without a teacher');
      // The section chip carries the two facts worth scanning.
      await expect(card).toContainText('0 of 40');
      await expect(card).toContainText('no class teacher');

      // ── The workbench ───────────────────────────────────────────────────────
      await card.getByRole('link', { name: 'Manage →' }).click();
      await page.waitForURL(`**/classes/${classId}`);

      const subjectsCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Subjects', level: 2 }) });
      await expect(subjectsCard).toContainText(subjectName);
      // "All 1 section" — a section with no list of its own studies everything the class offers.
      await expect(subjectsCard).toContainText('All 1 section');

      // Rename — the action that did not exist. A typo used to be permanent the moment an exam
      // result referenced the subject and blocked deletion.
      const renamed = `${subjectName}R`;
      await subjectsCard.locator('tr', { hasText: subjectName }).getByRole('button', { name: 'Rename' }).click();
      await subjectsCard.locator('tr input').first().fill(renamed);
      await subjectsCard.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('.toast.ok')).toContainText('Subject renamed');
      await expect(subjectsCard).toContainText(renamed);

      // Add a second subject so the section has something to choose BETWEEN.
      await fieldInput(subjectsCard, 'Add subject').fill(secondSubject);
      await subjectsCard.getByRole('button', { name: 'Add subject' }).click();
      await expect(page.locator('.toast.ok')).toContainText('Subject added');
      await expect(subjectsCard).toContainText(secondSubject);

      // ── The section pane: change what this section studies ──────────────────
      const sectionsCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Sections', level: 2 }) });
      await sectionsCard.locator('tr', { hasText: `Section ${sectionName}` }).getByRole('button', { name: 'Open' }).click();
      // The selection is in the URL, so the pane survives a refresh and a shared link.
      await expect(page).toHaveURL(new RegExp(`section=${sectionId}`));

      const pane = page.locator('.card').filter({ hasText: `${className} · Section ${sectionName}` }).last();
      await expect(pane).toContainText('Subjects this section studies');
      await expect(pane).toContainText('Same as the class — all 2 subjects');

      // Opt this section out of the second subject. Saving posts to the endpoint that had no
      // caller at all — assert it at the network layer so a regression that drops the change
      // fails here rather than only in the rendering.
      await pane.getByText('Choose for this section').click();
      await pane.getByRole('button', { name: secondSubject }).click(); // toggle it OFF
      const put = page.waitForRequest((r) => r.url().includes(`/sections/${sectionId}/subjects`) && r.method() === 'PUT');
      await pane.getByRole('button', { name: 'Save subjects' }).click();
      const posted = (await (await put).postDataJSON()) as { subjectIds: string[] };
      expect(posted.subjectIds).toHaveLength(1);
      await expect(page.locator('.toast.ok')).toContainText('Subjects updated for this section');

      // It stuck, and the exception is now visible where it matters.
      await page.reload();
      await expect(sectionsCard.locator('tr', { hasText: `Section ${sectionName}` })).toContainText('own list');

      // ── The tag turns green when a teacher is assigned ──────────────────────
      const teachers = await apiSetupGet<{ id: string; staffType: string; fullName: string | null }[]>(page, '/staff');
      const teacher = teachers.find((t) => t.staffType === 'TEACHER');
      test.skip(!teacher, 'no teacher on this tenant to assign');

      const years = await apiSetupGet<{ id: string; isCurrent: boolean }[]>(page, '/academic-years');
      const year = years.find((y) => y.isCurrent);
      test.skip(!year, 'no current academic year set');

      await apiSetupPost(page, '/teacher-assignments', {
        staffId: teacher!.id, academicYearId: year!.id, sectionId, subjectId: seeded.subjectId,
      });

      await page.goto('/classes');
      const after = page.locator('.card').filter({ has: page.getByRole('link', { name: className, exact: true }) });
      await expect(after).toContainText(`${renamed} · ${teacher!.fullName}`);
      await expect(after).not.toContainText(`${renamed} · unassigned`);
    } finally {
      // Leave the tenant as we found it. Sections and subjects go first — the server refuses
      // to delete a class while they reference it, and says so.
      const cookies = await page.context().cookies();
      const csrf = cookies.find((c) => c.name === 'csrf')?.value ?? '';
      const del = (path: string) =>
        page.request.delete(`http://localhost:3001/api/v1${path}`, { headers: { 'X-CSRF-Token': csrf } });
      for (const a of await apiSetupGet<{ id: string; sectionId: string }[]>(page, `/teacher-assignments?sectionId=${sectionId}`)) {
        await del(`/teacher-assignments/${a.id}`);
      }
      await del(`/sections/${sectionId}`);
      for (const s of await apiSetupGet<{ id: string }[]>(page, `/subjects?classId=${classId}`)) await del(`/subjects/${s.id}`);
      await del(`/classes/${classId}`);
    }
  });

  test('School configuration hands classes off rather than managing them', async ({ page }) => {
    await gotoApp(page, '/setup');
    const step = page.locator('.card').filter({ hasText: 'Classes, sections & subjects' });
    await expect(step).toBeVisible();
    // Setup used to embed the whole class manager, giving classes two homes with two sets of
    // handlers — and /classes/[id] then linked back here, which only linked forward again.
    await expect(step.getByRole('link', { name: /Manage classes|Add your first class/ })).toBeVisible();
    await expect(step.getByRole('button', { name: 'Add class' })).toHaveCount(0);
    await expect(step.getByRole('button', { name: '+ Section' })).toHaveCount(0);
  });
});
