import { fingerprintOf, parseAmount, parseDate, scoreClaim } from './reconciliation.service';

/**
 * The matcher, tested without a database.
 *
 * ⚠️ These are the rules that decide whether a school's money is attributed to the right child, so
 * they are pinned as pure functions rather than exercised only through an endpoint. The cases below
 * are the ones a real Pakistani bank export actually produces.
 */

const claim = (over: Partial<Parameters<typeof scoreClaim>[1]> = {}) => ({
  amount: 15000,
  transactionRef: 'TX88231',
  paidOn: new Date(Date.UTC(2026, 8, 15)),
  student: { fullName: 'Ayesha Khan' },
  ...over,
});

const line = (over: Partial<Parameters<typeof scoreClaim>[0]> = {}) => ({
  valueDate: new Date(Date.UTC(2026, 8, 15)),
  amount: 15000,
  narration: 'IBFT TRANSFER',
  reference: null as string | null,
  counterparty: null as string | null,
  ...over,
});

describe('parseAmount', () => {
  it('reads the shapes a bank actually prints', () => {
    expect(parseAmount('15,000.00')).toBe(15000);
    expect(parseAmount('Rs 15,000')).toBe(15000);
    expect(parseAmount('PKR 1,234.50')).toBe(1234.5);
    // Accounting notation for a debit — must not be read as income.
    expect(parseAmount('(500.00)')).toBe(-500);
  });

  it('returns null rather than NaN for anything unreadable', () => {
    // A null skips the row; a NaN would sail into a Decimal column.
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('  ')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe('parseDate', () => {
  it('reads an ambiguous date the LOCAL way — day first', () => {
    // ⚠️ 03/04/2026 is 3 April, not 3 March. Getting this backwards shifts every line by months and
    // would silently mis-age the whole reconciliation, so it is pinned rather than assumed.
    expect(parseDate('03/04/2026')?.toISOString().slice(0, 10)).toBe('2026-04-03');
    expect(parseDate('15-09-2026')?.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(parseDate('2026-09-15')?.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('returns null for junk instead of an Invalid Date', () => {
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe('fingerprintOf', () => {
  it('is stable for the same line, so a re-upload writes nothing', () => {
    // Accountants re-download overlapping ranges every day; the same credit arrives repeatedly.
    const a = fingerprintOf(new Date(Date.UTC(2026, 8, 15)), 15000, 'TX1', 'IBFT');
    const b = fingerprintOf(new Date(Date.UTC(2026, 8, 15)), 15000, 'TX1', 'IBFT');
    expect(a).toBe(b);
  });

  it('separates two genuinely different credits on the same day', () => {
    const a = fingerprintOf(new Date(Date.UTC(2026, 8, 15)), 15000, null, 'IBFT AYESHA');
    const b = fingerprintOf(new Date(Date.UTC(2026, 8, 15)), 15000, null, 'IBFT BILAL');
    expect(a).not.toBe(b);
  });
});

describe('scoreClaim', () => {
  it('EXACT when the bank gave a reference column and it is the one the parent typed', () => {
    const m = scoreClaim(line({ reference: 'TX88231' }), claim());
    expect(m).toMatchObject({ confidence: 'EXACT' });
    expect(m?.reason).toContain('TX88231');
  });

  it('matches a reference regardless of case and punctuation', () => {
    // Parents type what they see; banks print what they like.
    expect(scoreClaim(line({ reference: 'tx-88231' }), claim())?.confidence).toBe('EXACT');
  });

  it('STRONG when the reference is buried in the narration, which is where it usually lives', () => {
    const m = scoreClaim(line({ narration: 'IBFT/TX88231/AYESHA KHAN' }), claim());
    expect(m).toMatchObject({ confidence: 'STRONG' });
  });

  it('PROBABLE on amount, date and a recognisable name', () => {
    const m = scoreClaim(line({ counterparty: 'MUHAMMAD KHAN' }), claim({ transactionRef: null }));
    expect(m).toMatchObject({ confidence: 'PROBABLE' });
  });

  it('⚠️ refuses to match on amount and date alone', () => {
    // Two families paying the same fee on the same morning is ORDINARY. Picking between them is the
    // one thing this must never do, so the tier exists only to be excluded.
    const m = scoreClaim(line({ narration: 'IBFT TRANSFER' }), claim({ transactionRef: null }));
    expect(m?.confidence).toBe('WEAK');
  });

  it('does not match a different amount, however well the name fits', () => {
    const m = scoreClaim(line({ amount: 15001, counterparty: 'AYESHA KHAN' }), claim({ transactionRef: null }));
    expect(m).toBeNull();
  });

  it('allows a couple of days between paying and the bank posting it', () => {
    // A transfer made on the 15th can land on the 16th; that is the bank, not a different payment.
    const m = scoreClaim(
      line({ valueDate: new Date(Date.UTC(2026, 8, 17)), counterparty: 'AYESHA KHAN' }),
      claim({ transactionRef: null }),
    );
    expect(m?.confidence).toBe('PROBABLE');
  });

  it('does not reach across a week', () => {
    const m = scoreClaim(
      line({ valueDate: new Date(Date.UTC(2026, 8, 22)), counterparty: 'AYESHA KHAN' }),
      claim({ transactionRef: null }),
    );
    expect(m).toBeNull();
  });

  it('ignores a too-short reference, which would match almost anything', () => {
    // A three-character ref inside free text is a coincidence generator, not evidence.
    const m = scoreClaim(line({ narration: 'IBFT ABC TRANSFER' }), claim({ transactionRef: 'ABC', amount: 999 }));
    expect(m).toBeNull();
  });

  it('still matches an exact reference even when the amount differs', () => {
    // A part-payment against a claim is a discrepancy for a HUMAN to see, not a reason to hide the
    // only line that names the transaction.
    const m = scoreClaim(line({ reference: 'TX88231', amount: 10000 }), claim());
    expect(m?.confidence).toBe('EXACT');
  });
});
