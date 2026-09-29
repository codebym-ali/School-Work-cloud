import { test, expect, type Page } from '@playwright/test';
import { gotoApp, seedClassSectionStudent, apiSetupGet, apiSetupPost, apiSetupPatch } from './helpers';

interface Campus { id: string; name: string }
interface AcademicYear { id: string; isCurrent: boolean }
interface Klass { id: string; name: string }
interface Head { id: string; name: string }

/**
 * Fee Module Test Plan — the BROWSER cases (FEE-LC-*).
 *
 * The integration suite already owns the money arithmetic: idempotency, row locking, overpayment,
 * reversal, advances, proof policy, the integrity invariants. None of that is repeated here.
 *
 * ⚠️ **This file exists for one class of bug that a green API test cannot catch: a UI that is
 * stricter, or laxer, than the API behind it.** CSV import, `/my-attendance` and `/my-leaves` were
 * each unreachable by the only role allowed to use them — the endpoint worked and the capability was
 * gone. So these cases assert what a cashier can actually reach and do.
 */

const FEE_HEAD = 'E2E Lifecycle Tuition';
const AMOUNT = 6000;

/** Every method the school will be configured to accept for these cases. */
const METHODS = ['CASH', 'BANK_TRANSFER', 'EASYPAISA', 'JAZZCASH', 'CARD', 'CHEQUE'] as const;

/**
 * The methods that become a receipt at the counter.
 *
 * ⚠️ CHEQUE is deliberately absent (D3). It is not money until it clears, so it is recorded as a
 * submission and mints a receipt only when someone verifies it after the clearing date. This test
 * previously asserted a cheque reached PAID — which documented the bug rather than the rule.
 */
const IMMEDIATE = METHODS.filter((m) => m !== 'CHEQUE');

const monthKey = (year: number, month: number) => year * 12 + (month - 1);

/**
 * The next month nobody has billed yet.
 *
 * ⚠️ A (class, month, year) can be billed once EVER, and financial records are never deleted, so a
 * reused class accumulates billed months for ever. Walking forward from today re-walks the whole
 * backlog and eventually runs off the end — which is how `fees.spec` once started failing. Jump past
 * the frontier instead: read the highest month ANY class has billed and take the next slot.
 *
 * ⚠️ Page THROUGH the invoices: the endpoint sorts by `createdAt`, so a previous run's far-future
 * invoice has an old timestamp and is not on page one. One page would under-estimate the frontier.
 */
async function nextUnbilledMonth(page: Page): Promise<{ month: number; year: number }> {
  const now = new Date();
  let frontier = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
  for (let pageNo = 1; ; pageNo += 1) {
    const res = await apiSetupGet<{ data: { month: number | null; year: number }[]; total: number }>(
      page, `/fees/invoices?pageSize=100&page=${pageNo}`);
    for (const inv of res.data) frontier = Math.max(frontier, monthKey(inv.year, inv.month ?? 1));
    if (res.data.length < 100 || pageNo * 100 >= res.total) break;
  }
  const key = frontier + 1;
  return { month: (key % 12) + 1, year: Math.floor(key / 12) };
}

/** Bill one month for one class through the UI, and confirm the server actually generated it. */
async function generateBatch(page: Page, className: string, month: number, year: number): Promise<number> {
  const card = page.locator('.card', { hasText: 'Generate invoices' });
  await card.locator('label:text-is("Class") + select').selectOption({ label: className });
  await card.locator('label:text-is("Month") + input').fill(String(month));
  await card.locator('label:text-is("Year") + input').fill(String(year));
  // ⚠️ Read the RESPONSE, not the toast: a toast from a previous action lingers, so a just-billed
  // month can still look unbilled.
  const posted = page.waitForResponse((r) => r.url().includes('/fees/invoice-batches') && r.request().method() === 'POST');
  await card.getByRole('button', { name: 'Generate' }).click();
  const body = (await (await posted).json()) as { generated?: number };
  return body.generated ?? 0;
}

test.describe('fee lifecycle — browser', () => {
  test.describe.configure({ mode: 'serial' });

  let className = '';
  let studentName = '';

  /**
   * The seeded student's invoice row.
   *
   * ⚠️ Asserts the name is set first. `hasText: ''` matches EVERY row, so when the first test in a
   * serial suite fails, every later case dies with a strict-mode violation listing twenty buttons —
   * which hides the real failure behind a locator error twenty lines long.
   */
  const invoiceRow = (page: Page) => {
    expect(studentName, 'the seeded student was never created — see the first test').not.toBe('');
    return page.locator('tbody tr', { hasText: studentName });
  };

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await gotoApp(page);
    // Accept every method, so the dropdown offers them and FEE-3.3..3.8 can be exercised.
    // proofPolicy OFF keeps these cases about the METHOD; the proof rules have their own spec.
    await apiSetupPatch(page, '/school-settings', {
      feeSubmission: { methods: [...METHODS], proofPolicy: 'OFF' },
    });
    await page.close();
  });

  test('FEE-LC-1 · a class with no fee structure cannot be billed, then a priced one can', async ({ page }) => {
    await gotoApp(page);
    const seeded = await seedClassSectionStudent(page, { name: 'E2E FeeLC' });
    className = seeded.className;
    studentName = seeded.studentName;

    const [campuses, years, classes] = await Promise.all([
      apiSetupGet<Campus[]>(page, '/campuses'),
      apiSetupGet<AcademicYear[]>(page, '/academic-years'),
      apiSetupGet<Klass[]>(page, '/classes'),
    ]);
    const classId = classes.find((c) => c.name === className)!.id;

    await page.getByRole('link', { name: 'Fees', exact: true }).click();
    await page.waitForURL('**/fees');

    const card = page.locator('.card', { hasText: 'Generate invoices' });
    await card.locator('label:text-is("Class") + select').selectOption({ label: className });

    // ⚠️ FEE-1.5 is asserted only while the class genuinely HAS no price.
    //
    // `seedClassSectionStudent` reuses the same class across runs, so on the second run it is
    // already priced and Generate is correctly ENABLED. Asserting "disabled" unconditionally made
    // this test pass once and fail for ever after — a fixture-reuse trap, not a product bug. The
    // condition is read from the API rather than guessed from the button it is checking.
    const priced = await apiSetupGet<{ id: string }[]>(page, `/fee-structures?classId=${classId}`);
    if (priced.length === 0) {
      await expect(card.getByRole('button', { name: 'Generate' }),
        'an unpriced class must not be billable').toBeDisabled();
    }

    // Price it. ⚠️ Find-before-create: this spec used to mint a head per run and the demo tenant
    // reached 33 of 64 fee heads as test debris.
    const heads = await apiSetupGet<Head[]>(page, '/fee-heads');
    const head = heads.find((h) => h.name === FEE_HEAD)
      ?? await apiSetupPost<Head>(page, '/fee-heads', { name: FEE_HEAD });
    // ⚠️ Find-before-create the STRUCTURE too, not just the head. `seedClassSectionStudent` reuses
    // the same class across runs, so a second run hits
    // `This class already has a price for that fee from …` — a 409 that killed the whole serial
    // suite on its second run and left every later case looking broken. The same fixture-reuse trap
    // the fee head comment above describes; it applies one level down as well.
    if (priced.length === 0) {
      await apiSetupPost(page, '/fee-structures', {
        campusId: campuses[0].id,
        classId,
        feeHeadId: head.id,
        academicYearId: (years.find((y) => y.isCurrent) ?? years[0]).id,
        amount: AMOUNT,
        frequency: 'MONTHLY',
      });
    }

    await page.reload();
    const { month, year } = await nextUnbilledMonth(page);
    expect(await generateBatch(page, className, month, year), 'one invoice for the seeded student').toBe(1);

    const row = invoiceRow(page);
    await expect(row).toContainText('Rs 6,000');
    await expect(row.locator('.badge')).toContainText('Pending');
  });

  test('FEE-LC-2 · the method dropdown offers exactly what the school accepts', async ({ page }) => {
    // ⚠️ The case this file exists for. A method offered but rejected by the server is a trap laid
    // for a cashier with a parent at the counter; a method accepted but hidden is a capability
    // silently deleted. The two lists must be the same list.
    await gotoApp(page, '/fees');
    const row = invoiceRow(page);
    await row.getByRole('button', { name: 'Collect' }).click();

    const select = row.locator('select');
    const offered = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(offered.sort()).toEqual([...METHODS].sort());
  });

  test('FEE-LC-4 · a non-cash payment without a reference is refused', async ({ page }) => {
    // The rule lives in the API (`transactionRef required for non-cash`). What matters here is that
    // a cashier who omits it is TOLD, rather than left looking at a row that did not change.
    await gotoApp(page, '/fees');
    const row = invoiceRow(page);
    await row.getByRole('button', { name: 'Collect' }).click();
    await row.locator('input[placeholder="Amount"]').fill('1000');
    await row.locator('select').selectOption('BANK_TRANSFER');

    const ref = row.locator('input[placeholder*="Reference" i], input[placeholder*="Transaction" i]').first();
    if (await ref.count()) await ref.fill('');

    const posted = page.waitForResponse((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.request().method() === 'POST');
    await row.getByRole('button', { name: 'Save' }).click();
    expect((await posted).status(), 'a non-cash payment with no reference must be refused').toBe(422);
    // ⚠️ Match the MESSAGE, not just `.toast.err`. The MFA banner is also a `.toast.err` and is
    // permanently on screen for an owner, so a bare class selector resolves two elements and fails
    // strict mode — while proving nothing about what the cashier was told. What matters is that the
    // refusal names the missing field rather than leaving a row that silently did not change.
    await expect(page.locator('.toast.err', { hasText: /transactionRef|reference/i })).toBeVisible();
  });

  test('FEE-LC-3 · every accepted method collects, and the invoice reaches PAID', async ({ page }) => {
    // Rs 6,000 in six parts: one per method, so each is exercised against a real invoice rather
    // than asserted from the dropdown. The last one takes the invoice to PAID.
    await gotoApp(page, '/fees');
    const each = AMOUNT / IMMEDIATE.length; // 1200

    for (const [i, method] of IMMEDIATE.entries()) {
      const row = invoiceRow(page);
      await row.getByRole('button', { name: 'Collect' }).click();
      await row.locator('input[placeholder="Amount"]').fill(String(each));
      await row.locator('select').selectOption(method);

      if (method !== 'CASH') {
        const ref = row.locator('input[placeholder*="Reference" i], input[placeholder*="Transaction" i]').first();
        await ref.fill(`E2E-${method}-${Date.now()}`);
      }

      const posted = page.waitForResponse((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.request().method() === 'POST');
      await row.getByRole('button', { name: 'Save' }).click();
      const res = await posted;
      expect(res.status(), `${method} should have been accepted`).toBe(201);

      // Every payment mints a receipt number — a payment without one would be money with no paper.
      const body = (await res.json()) as { receiptNo?: number };
      expect(body.receiptNo, `${method} produced no receipt number`).toBeTruthy();

      await expect(page.locator('.toast.ok')).toContainText('Payment recorded');
      const after = page.locator('tbody tr', { hasText: studentName });
      await expect(after.locator('.badge')).toContainText(i === IMMEDIATE.length - 1 ? 'Paid' : 'Partial');
    }
  });

  test('FEE-LC-12 · a cheque is recorded as a submission, not a receipt', async ({ page }) => {
    // ⚠️ D3 — the case this whole change exists for. A cheque handed over at the counter must not
    // hand back a receipt: if it bounces, the family already holds proof of a payment the school
    // never received, and the school holds a reversal to unwind.
    await gotoApp(page, '/fees');
    // ⚠️ Bill a FRESH month. The method loop above takes the previous invoice to PAID, so this case
    // skipped itself — a test that quietly does not run is worse than one that fails, because the
    // suite still reads green.
    const { month, year } = await nextUnbilledMonth(page);
    expect(await generateBatch(page, className, month, year)).toBe(1);

    const row = invoiceRow(page).first();
    await row.getByRole('button', { name: 'Collect' }).click();
    await row.locator('input[placeholder="Amount"]').fill('500');
    await row.locator('select').selectOption('CHEQUE');
    const ref = row.locator('input[placeholder*="Reference" i], input[placeholder*="Transaction" i]').first();
    await ref.fill(`E2E-CHQ-${Date.now()}`);

    // It goes to the CLAIMS endpoint, not to payments — that routing is the fix.
    const posted = page.waitForResponse((r) => r.url().includes('/fees/claims') && r.request().method() === 'POST');
    await row.getByRole('button', { name: 'Save' }).click();
    const res = await posted;
    expect(res.status()).toBe(201);
    const claim = (await res.json()) as { clearsOn: string | null };
    expect(claim.clearsOn, 'a cheque must carry a clearing date').toBeTruthy();

    // And the clerk is TOLD when it becomes money, rather than left guessing.
    await expect(page.locator('.toast.ok', { hasText: /clears on/i })).toBeVisible();
  });

  test('FEE-LC-11 · a PAID invoice cannot be collected against again', async ({ page }) => {
    await gotoApp(page, '/fees');
    // ⚠️ Scoped to the PAID row, not just "this student's row". The cheque case above bills a second
    // invoice for the same child, so a name-only locator now finds two — and would assert PAID
    // against the fresh, deliberately unpaid one.
    const row = invoiceRow(page).filter({ has: page.locator('.badge', { hasText: 'Paid' }) }).first();
    await expect(row.locator('.badge')).toContainText('Paid');
    // Either the button is gone, or the server refuses with 409. Both are correct; silently
    // accepting a seventh payment is not.
    const collect = row.getByRole('button', { name: 'Collect' });
    if (await collect.count() === 0) return;
    await collect.click();
    await row.locator('input[placeholder="Amount"]').fill('100');
    const posted = page.waitForResponse((r) => /\/fees\/invoices\/.+\/payments/.test(r.url()) && r.request().method() === 'POST');
    await row.getByRole('button', { name: 'Save' }).click();
    expect((await posted).status()).toBe(409);
  });
});

/**
 * Reconciliation (FEE-5) — the newest surface, and the one with no browser coverage at all.
 *
 * Runs against a CSV built in the test rather than a fixture file: the point is the MAPPING of an
 * unfamiliar bank's columns, so inventing column names here is the realistic case.
 */
test.describe('bank statement reconciliation — browser', () => {
  test.describe.configure({ mode: 'serial' });

  const csv = [
    'Txn Date,Credit Amt,Details,Ref No,Remitter',
    '15/09/2026,25000.00,IBFT TRANSFER,E2E-REC-001,MUHAMMAD IMRAN',
    '15/09/2026,7500.00,IBFT/E2E-REC-002/SCHOOL FEE,,AYESHA BIBI',
    '16/09/2026,3200.00,CASH DEPOSIT,,WALK IN',
  ].join('\n');

  async function openImport(page: Page) {
    await gotoApp(page, '/fee-claims');
    // ⚠️ Wait for the QUEUE to settle first. The claims fetch re-renders the page, which detaches
    // the import card's button mid-click ("element was detached from the DOM, retrying") — the same
    // race as a `selectOption` firing before a page's own data load, already in Key Decisions.
    // Settling on the outcome, not on a spinner: either rows arrived or the empty state did.
    await expect(
      page.locator('tbody tr').first().or(page.getByText(/No .*submissions|Nothing is waiting/i).first()),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Upload statement' }).click();
    await page.getByLabel('Bank').fill('E2E Test Bank');
    await page.getByLabel('Statement file (CSV)').setInputFiles({
      name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv),
    });
    // The column pickers only appear once a header has been read client-side.
    await expect(page.getByLabel('Date *')).toBeVisible();
  }

  test('FEE-LC-8 · preview parses the bank’s own columns and stores nothing', async ({ page }) => {
    await openImport(page);

    // ⚠️ The mapping is the whole reason this works against a bank nobody has seen. These headers
    // are deliberately not the ones any parser would guess.
    await page.getByLabel('Date *').selectOption('Txn Date');
    await page.getByLabel('Credit amount *').selectOption('Credit Amt');
    await page.getByLabel('Narration').selectOption('Details');
    await page.getByLabel('Reference').selectOption('Ref No');
    await page.getByLabel('Payer name').selectOption('Remitter');

    const previewed = page.waitForResponse((r) => r.url().includes('/fees/statements/preview') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Preview' }).click();
    const body = (await (await previewed).json()) as { parsed: number; committed: boolean; statementId?: string };

    expect(body.parsed, 'three credit lines').toBe(3);
    // FEE-5.7 — a preview must not create anything, least of all a receipt.
    expect(body.committed).toBe(false);
    expect(body.statementId).toBeUndefined();
    await expect(page.getByText('3 credit lines')).toBeVisible();
  });

  test('FEE-LC-9 · importing twice stores the lines once', async ({ page }) => {
    // ⚠️ Accountants re-download overlapping ranges every day ("last 7 days", daily), so the same
    // credit arrives repeatedly. The fingerprint is what makes that safe, and this is the case that
    // proves it end to end rather than in a unit test.
    await openImport(page);
    await page.getByLabel('Date *').selectOption('Txn Date');
    await page.getByLabel('Credit amount *').selectOption('Credit Amt');
    await page.getByLabel('Narration').selectOption('Details');

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('3 credit lines')).toBeVisible();

    const first = page.waitForResponse((r) => r.url().endsWith('/fees/statements') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Import/ }).click();
    const firstBody = (await (await first).json()) as { stored: number };

    // Re-upload the identical statement.
    await openImport(page);
    await page.getByLabel('Date *').selectOption('Txn Date');
    await page.getByLabel('Credit amount *').selectOption('Credit Amt');
    await page.getByLabel('Narration').selectOption('Details');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('3 credit lines')).toBeVisible();
    const second = page.waitForResponse((r) => r.url().endsWith('/fees/statements') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Import/ }).click();
    const secondBody = (await (await second).json()) as { stored: number };

    expect(secondBody.stored, 'a re-upload must store nothing').toBe(0);
    expect(firstBody.stored + secondBody.stored).toBe(firstBody.stored);
  });

  test('FEE-LC-10 · credits nothing claims are listed as unexplained', async ({ page }) => {
    // ⚠️ The most valuable output and the one nobody asks for: somebody paid and never told the
    // school, and that child may be sitting on a defaulter list.
    await gotoApp(page, '/fee-claims');
    const loaded = page.waitForResponse((r) => r.url().includes('/fees/statements/unexplained'));
    await page.getByRole('button', { name: /Money we can.t explain/ }).click();
    const rows = (await (await loaded).json()) as { narration: string }[];

    expect(rows.length, 'the imported lines match no claim, so all three are unexplained').toBeGreaterThanOrEqual(3);
    // ⚠️ Scoped to the HEADING, and by class rather than by words. The button that opens this
    // section carries the same phrase, so a text match resolves both and fails strict mode — and a
    // curly apostrophe matches neither, since the markup authors `can&apos;t` (a straight quote).
    await expect(page.locator('.section-title', { hasText: /Money we can.t explain/ })).toBeVisible();
  });
});
