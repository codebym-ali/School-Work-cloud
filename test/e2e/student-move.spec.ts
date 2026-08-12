import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, seedClassSectionStudent } from './helpers';

/**
 * Moving a student between sections, from the Students screen (Student Transfer Plan, X1).
 *
 * ⚠️ **The endpoint has existed since M2 and had no UI at all** — the fourth time in this project
 * that the API permitted something and the interface silently did not, after CSV import,
 * `/my-attendance` and `/my-leaves`. So the assertion that matters is not that the API works
 * (integration covers that) but that a person can *reach* it.
 *
 * Reuses the shared OWNER session and adds no form login of its own — the right default, though
 * ⚠️ **not for the reason first written here.** That comment claimed the suite sat at the §29
 * ceiling of 5 logins per IP per 15 minutes. It does not: the run makes roughly **thirteen** logins
 * anyway (`seedClassSectionStudent`, used below, signs in as the admission officer and eight specs
 * call it), and measured on 2026-08-11 the limiter does not fire at all — seven consecutive logins
 * returned 200 with the flag set both ways. See Key Decisions.
 */
test.describe('student move', () => {
  test('an admin can move a student to another section, and the screen says what stays behind', async ({ page }) => {
    await gotoApp(page);
    const { className, sectionName, sectionId, classId, campusId, studentName } = await seedClassSectionStudent(page, { name: 'E2E Move' });

    // A second section in the same class to move into — **reused, not minted per run.** A fresh
    // `S<timestamp>` section each time was quietly growing the shared class, which is both the
    // debris this cleanup exists to remove and what made a sibling spec's section count wrong.
    const toName = 'Z';
    const existing = await apiSetupGet<{ id: string; name: string }[]>(page, `/sections?classId=${classId}`);
    const to = existing.find((x) => x.name === toName)
      ?? await apiSetupPost<{ id: string }>(page, '/sections', { classId, name: toName, capacity: 40 });

    // Filtered to the seeded class rather than the unfiltered list: demo carries hundreds of
    // students and a fresh one is not on page 1.
    await page.goto(`/students?campusId=${campusId}&classId=${classId}`);

    const row = page.locator('tbody tr', { hasText: studentName });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Move', exact: true }).click();

    const dialog = page.locator('.card', { hasText: `Move — ${studentName}` });
    await expect(dialog).toBeVisible();
    // Where they are now, resolved from their active enrolment — a user cannot tell a correction
    // from a mistake without it.
    await expect(dialog).toContainText(`Currently ${className}-${sectionName}`);
    // ⚠️ The sentence about what does NOT move. Without it a user expects the whole year to follow
    // the child and reports the history staying behind as data loss.
    await expect(dialog).toContainText('Only today onwards moves');

    // `label + select`, not `getByLabel`: these labels are siblings rather than associated, which
    // is the pattern the rest of the suite already uses on this app.
    await dialog.locator('label:text-is("Class") + select').selectOption(classId);
    const sectionSelect = dialog.locator('label:text-is("Section") + select');
    // Seats live on the option itself: "0 of 40" read while choosing beats a refusal afterwards.
    // The COUNT is deliberately not pinned: the section is reused across runs and a crash before
    // teardown can leave an active student in it, which would fail an assertion about the feature
    // rather than about the seeding.
    await expect(sectionSelect).toContainText(new RegExp(`${toName} — [0-9]+ of 40 seats`));
    await sectionSelect.selectOption(to.id);
    await dialog.getByRole('button', { name: 'Move student' }).click();

    await expect(page.locator('.toast.ok')).toContainText(`moved to ${className}-${toName}`);

    // The move is real, not just a toast: the enrolment endpoint agrees.
    const active = await apiSetupGet<{ data: { sectionId: string }[] }>(
      page, `/enrollments?sectionId=${to.id}&status=ACTIVE`);
    expect(active.data.some((e) => e.sectionId === to.id)).toBe(true);
    // And the section they left no longer holds them — asserting only the destination would pass
    // on an endpoint that copied the enrolment instead of moving it.
    // ⚠️ Asked about THIS CHILD, not about the section's population. `toHaveLength(0)` was a
    // statement about the tenant — it held only while every run got a brand-new section, and a run
    // that crashes before teardown leaves an active child behind and fails the next one for a
    // reason that has nothing to do with moving students.
    const old = await apiSetupGet<{ data: { student: { fullName: string } }[] }>(
      page, `/enrollments?sectionId=${sectionId}&status=ACTIVE`);
    expect(old.data.some((e) => e.student.fullName === studentName)).toBe(false);

    // ── X2: the same action from the student's own record ─────────────────────
    // Someone reading one child's profile is exactly who notices they are in the wrong room, and
    // sending them back to the list to act on what is already on screen is how a capability goes
    // unused — which is the whole reason this feature had no UI for four months.
    await page.locator('tbody tr', { hasText: studentName }).getByRole('button', { name: 'View', exact: true }).click();
    const enrolment = page.locator('.card', { hasText: 'Current enrollment' });
    await expect(enrolment).toContainText(toName);
    await enrolment.getByRole('button', { name: 'Move', exact: true }).click();

    const profileDialog = page.locator('.card', { hasText: `Move — ${studentName}` });
    await expect(profileDialog).toContainText(`Currently ${className}-${toName}`);
    await profileDialog.locator('label:text-is("Class") + select').selectOption(classId);
    await profileDialog.locator('label:text-is("Section") + select').selectOption(sectionId);
    await profileDialog.getByRole('button', { name: 'Move student' }).click();

    // The profile refetches in place: the card behind the dialog must show where they are NOW, not
    // where they were when the page loaded. A stale card would contradict the toast above it.
    //
    // ⚠️ Asserted as "no longer names the section they LEFT", not as "contains the section they
    // returned to". The first version did the latter, and `sectionName` is a single letter — which
    // the card already contained inside "Status ACTIVE". It passed with the refetch deleted.
    // A generated name is unique; a letter is a substring of half the page.
    await expect(enrolment).not.toContainText(toName);
  });
});
