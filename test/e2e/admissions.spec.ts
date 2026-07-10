import { test, expect } from '@playwright/test';
import { gotoApp, fieldInput, fieldSelect, cardByHeading } from './helpers';

test.describe('admissions', () => {
  test('inquiry -> entry test -> admit -> appears in Students', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('link', { name: 'Admissions', exact: true }).click();
    await page.waitForURL('**/admissions');

    const ts = Date.now();
    const studentName = `Test Applicant ${ts}`;
    // Guardian phones are unique per school (link-by-phone) — derive one from the
    // timestamp so repeat runs of this spec don't collide with a prior run's guardian.
    const guardianPhone = `03${String(ts).slice(-9)}`;

    // 1) Create inquiry
    await page.getByRole('button', { name: '+ New inquiry' }).click();
    const newInquiryCard = cardByHeading(page, 'New inquiry');
    await fieldSelect(newInquiryCard, 'Campus').selectOption({ index: 1 });
    await fieldSelect(newInquiryCard, 'Desired class').selectOption({ index: 1 });
    await fieldInput(newInquiryCard, 'Student name').fill(studentName);
    await fieldInput(newInquiryCard, 'Guardian name').fill('Test Guardian');
    await fieldInput(newInquiryCard, 'Guardian phone').fill(guardianPhone);
    await newInquiryCard.getByRole('button', { name: 'Create inquiry' }).click();

    await expect(page.locator('.toast.ok')).toContainText('Inquiry created');
    const row = page.locator('tr', { hasText: studentName });
    await expect(row).toBeVisible();

    // 2) Schedule entry test
    await row.getByRole('button', { name: 'Schedule test' }).click();
    const when = new Date(Date.now() + 3600_000).toISOString().slice(0, 16);
    await fieldInput(page.locator('body'), 'Scheduled at').fill(when);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Entry test scheduled');

    // 3) Record entry test result — passed
    const row2 = page.locator('tr', { hasText: studentName });
    await row2.getByRole('button', { name: 'Record result' }).click();
    await fieldSelect(page.locator('body'), 'Result').selectOption('true');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Entry test recorded');

    // 4) Admit
    const row3 = page.locator('tr', { hasText: studentName });
    await row3.getByRole('button', { name: 'Admit' }).click();
    const admitCard = cardByHeading(page, `Admit ${studentName}`);
    await fieldInput(admitCard, 'Date of birth').fill('2015-01-15');
    await fieldSelect(admitCard, 'Section').selectOption({ index: 1 });
    await admitCard.getByRole('button', { name: 'Admit student' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Admitted');

    // 5) Verify the new student appears in Students
    await page.getByRole('link', { name: 'Students', exact: true }).click();
    await page.waitForURL('**/students');
    await fieldInput(page.locator('body'), 'Search (name / GR / phone)').fill(studentName);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('table')).toContainText(studentName);
  });
});
