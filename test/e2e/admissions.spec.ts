import { test, expect } from '@playwright/test';
import { gotoApp, login, apiSetupGet, e2eOfficer, fieldInput, fieldSelect, cardByHeading } from './helpers';

/**
 * The enquiry pipeline: inquiry → entry test → admit.
 *
 * Two reasons this could never pass as written, both structural rather than incidental:
 *  - it navigated via a sidebar "Admissions" link that a **DIRECT** school deliberately hides
 *    from everyone but the officer (no enquiry pipeline ⇒ the page is a dead end);
 *  - every step it drives — inquiry, entry test, admit — only exists in **PIPELINE** mode, where
 *    in DIRECT "the form IS the page". So on a DIRECT tenant there is nothing here to test.
 *
 * It now checks the school's mode and skips when there is no pipeline, and runs as the admission
 * officer, who is both the only role that may admit and the only one this page is built for.
 */
test.describe('admissions', () => {
  // The whole spec runs as the admission OFFICER, whose door + screens live on staff-web (:3006).
  // The owner-seeding calls (e2eOfficer) still work here because dev cookies are host-scoped, so the
  // shared owner storageState reaches :3006 too — until the officer login below takes the session over.
  test.use({ baseURL: 'http://localhost:3006' });

  test('inquiry -> entry test -> admit -> appears in Students', async ({ page }) => {
    await gotoApp(page);
    const settings = await apiSetupGet<{ admissionsMode: string }>(page, '/school-settings');
    test.skip(settings.admissionsMode !== 'PIPELINE', 'This tenant is DIRECT — it has no enquiry pipeline to drive.');

    const officer = await e2eOfficer(page);
    // ⚠️ Lands on `/home` since Phase 2 (Role-Based Home Dashboard Plan): an Admission
    // Controller has no `/dashboard` and used to be dropped cold into the pipeline; the
    // home names what is waiting first. The pipeline is one navigation away, below.
    await login(page, officer.email, officer.password, '**/home', 'staff');
    await gotoApp(page, '/admissions');

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
