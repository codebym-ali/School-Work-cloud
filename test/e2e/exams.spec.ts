import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, fieldSelect, cardByHeading, seedClassSectionStudent } from './helpers';

/**
 * Exercises a realistic slice of the exam lifecycle end-to-end: term + subject setup,
 * exam creation, opening marks entry, entering marks, viewing results, and publishing
 * (which requires 100% mark completeness for the class). A dedicated class/section/
 * student is created per run so the publish completeness gate is deterministic and
 * doesn't depend on data left over from other specs (e.g. admissions.spec.ts also
 * admits students into the shared seeded "Grade 1" class).
 */
test.describe('exams', () => {
  test('term + exam -> open marks entry -> enter marks -> results -> publish -> report card', async ({ page }) => {
    await gotoApp(page);
    const ts = Date.now();
    const termName = `ExamTerm${ts}`;
    const examName = `Test Exam ${ts}`;

    // 1) Fixture: a dedicated class + section + subject + admitted student, seeded through
    //    the API. This used to be 30 lines driving a "Classes" card and a separate "Sections"
    //    card on Setup, plus an "Add subject" form on this page — none of which exist now
    //    (structure moved to Classes, and the Exams subjects card is deliberately read-only
    //    so subjects have one home). A spec should not be a hostage of whichever screen owns
    //    its fixture data this month.
    const { className, sectionName, subjectName, studentName } = await seedClassSectionStudent(page);

    // 2) Exams page: term, exam
    await page.getByRole('link', { name: 'Exams', exact: true }).click();
    await page.waitForURL('**/exams');

    // The subject seeded above must be visible on the read-only card.
    await expect(cardByHeading(page, 'Subjects')).toContainText(subjectName);

    const termsCard = cardByHeading(page, 'Terms');
    await fieldSelect(termsCard, 'Academic year').selectOption({ index: 1 });
    await fieldInput(termsCard, 'Name').fill(termName);
    await fieldInput(termsCard, 'Start').fill('2026-07-01');
    await fieldInput(termsCard, 'End').fill('2026-07-31');
    await termsCard.getByRole('button', { name: 'Add term' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Term created');

    const examsCard = cardByHeading(page, 'Exams');
    // The card also has a Class/Term *filter* row above the create form — both use the
    // same label text, so scope to the create form specifically (its own .inline-form).
    const newExamForm = examsCard.locator('.inline-form').nth(1);
    await fieldSelect(newExamForm, 'Term').selectOption({ label: termName });
    await fieldSelect(newExamForm, 'Class').selectOption({ label: className });
    await fieldInput(newExamForm, 'Name').fill(examName);
    await fieldInput(newExamForm, 'Exam date').fill('2026-07-08');
    await newExamForm.getByRole('button', { name: 'Create exam' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Exam created');

    // 4) Open marks entry
    const examRow = page.locator('tr', { hasText: examName });
    await expect(examRow).toBeVisible();
    await examRow.getByRole('button', { name: 'Open marks entry' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Marks entry opened');

    // 5) Enter marks for the one student x one subject
    // The expanded panel renders as a row inside the same outer "Exams" card's table,
    // so cardByHeading matches both that outer card and the panel's own nested card —
    // `.last()` picks the nested (more specific) one, since it appears later in the DOM.
    await examRow.getByRole('button', { name: 'Enter marks' }).click();
    const marksPanel = cardByHeading(page, `Enter marks — ${examName}`).last();
    await fieldSelect(marksPanel, 'Section').selectOption({ label: sectionName });
    await marksPanel.getByRole('button', { name: 'Load roster' }).click();
    await expect(marksPanel.locator('table')).toContainText(studentName);
    const marksInput = marksPanel.locator('table tbody tr').first().locator('td').nth(3).locator('input');
    await marksInput.fill('88');
    // Guard against the state-clobber race: the value must still be 88 right before save.
    await expect(marksInput).toHaveValue('88');
    // Capture the actual bulk payload so a regression that drops the mark (posts 0) fails
    // at the network layer, not only via the rendered result.
    const bulkReq = page.waitForRequest((r) => r.url().includes('/results/bulk') && r.method() === 'POST');
    await marksPanel.getByRole('button', { name: 'Save marks' }).click();
    const postedRecords = (await (await bulkReq).postDataJSON()).records as Array<{ marksObtained?: number }>;
    expect(postedRecords[0].marksObtained).toBe(88);
    await expect(marksPanel).toContainText('Saved 1, failed 0');

    // 6) View results
    await examRow.getByRole('button', { name: 'Results' }).click();
    const resultsPanel = cardByHeading(page, 'Results').last();
    await expect(resultsPanel).toContainText(studentName);
    await expect(resultsPanel).toContainText('88 / 100');

    // 7) Publish (completeness gate: the only enrollment/subject pair is now marked)
    await examRow.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Exam published');
    await expect(examRow.locator('.badge')).toContainText('PUBLISHED');

    // 8) Generate + view the term's report cards
    const reportCard = cardByHeading(page, 'Report cards');
    await fieldSelect(reportCard, 'Term').selectOption({ label: termName });
    await reportCard.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Report cards generated');
    await expect(reportCard.locator('table')).toBeVisible();
  });
});
