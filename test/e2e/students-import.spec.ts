import { test, expect } from '@playwright/test';
import { gotoApp, seedClassSectionStudent, cardByHeading } from './helpers';

/**
 * Students CSV import (§22.6) — drives the real UI against the live API. Seeds a fresh
 * class/section, then: (1) Validate (dryRun) a file with a bad row → the per-row error
 * report renders and nothing is written; (2) Import a clean file with two siblings sharing
 * one guardian phone → "Imported 2" and both appear in the directory.
 */
test.describe('students CSV import', () => {
  test('validate reports bad rows, then a clean import adds siblings', async ({ page }) => {
    await gotoApp(page);
    const { className, sectionName } = await seedClassSectionStudent(page); // lands on /students

    const ts = Date.now();
    const phone = `03${String(ts).slice(-9)}`;
    const header = 'fullName,gender,dateOfBirth,className,sectionName,guardianName,guardianPhone,relation';
    const good1 = `Imp One ${ts},MALE,2015-06-10,${className},${sectionName},Imp Guardian ${ts},${phone},FATHER`;
    const good2 = `Imp Two ${ts},FEMALE,2017-06-10,${className},${sectionName},Imp Guardian ${ts},${phone},FATHER`;
    const badGender = `Imp Bad ${ts},MARTIAN,2015-06-10,${className},${sectionName},X,${phone},FATHER`;

    await page.getByRole('button', { name: 'Import CSV' }).click();
    const card = cardByHeading(page, 'Import students (CSV)');
    const textarea = card.locator('textarea');

    // 1) Validate a file with a bad row → error report, nothing written.
    await textarea.fill([header, good1, badGender].join('\n'));
    await card.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(card.locator('.toast.err')).toContainText(/nothing was imported/i);
    await expect(card.locator('table')).toContainText('gender');

    // 2) Import a clean file with two siblings (shared phone) → imported, both listed.
    await textarea.fill([header, good1, good2].join('\n'));
    await card.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(card.locator('.toast.ok')).toContainText('Imported 2 student(s)');

    // Both are searchable in the directory.
    await page.locator('label:text-is("Search (name / GR / phone)") + input').fill(`Imp One ${ts}`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('table')).toContainText(`Imp One ${ts}`);
  });
});
