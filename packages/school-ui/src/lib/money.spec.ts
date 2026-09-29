import { moneyExact, moneyShort, percentOf } from './money';

describe('moneyShort — lakh/crore for glanceable surfaces', () => {
  it('prints figures under one lakh in full, with thousands separators', () => {
    expect(moneyShort(0)).toBe('Rs 0');
    expect(moneyShort(45000)).toBe('Rs 45,000');
    expect(moneyShort(99999.4)).toBe('Rs 99,999');
    expect(moneyShort(45000, 'short')).toBe('Rs 45,000');
  });

  it('switches to lakh at exactly 1,00,000 and drops trailing zeros', () => {
    expect(moneyShort(100000)).toBe('Rs 1 lakh');
    expect(moneyShort(675000)).toBe('Rs 6.75 lakh');
    expect(moneyShort(650000)).toBe('Rs 6.5 lakh');
    expect(moneyShort(918000)).toBe('Rs 9.18 lakh');
    expect(moneyShort(675000, 'short')).toBe('Rs 6.75L');
  });

  it('rounds to two decimals of a lakh', () => {
    expect(moneyShort(123456)).toBe('Rs 1.23 lakh');
    expect(moneyShort(405001)).toBe('Rs 4.05 lakh');
  });

  it('rolls over to crore when rounding reaches 100 lakh, never printing "100 lakh"', () => {
    expect(moneyShort(9_999_999)).toBe('Rs 1 crore');
    expect(moneyShort(10_000_000)).toBe('Rs 1 crore');
    expect(moneyShort(12_500_000)).toBe('Rs 1.25 crore');
    expect(moneyShort(12_500_000, 'short')).toBe('Rs 1.25Cr');
  });

  it('keeps the sign and refuses non-numbers', () => {
    expect(moneyShort(-250000)).toBe('-Rs 2.5 lakh');
    expect(moneyShort(Number.NaN)).toBe('—');
  });
});

describe('percentOf', () => {
  it('is a whole-number share of the base', () => {
    expect(percentOf(675000, 918000)).toBe(74);
    expect(percentOf(0, 918000)).toBe(0);
  });

  it('is null when nothing was billed — there is no base to be a share of', () => {
    expect(percentOf(5000, 0)).toBeNull();
  });

  it('caps at 100 when advances push collections past the month\'s billing', () => {
    expect(percentOf(1_200_000, 918000)).toBe(100);
  });
});

describe('moneyExact — full rupees for ledgers and report tables', () => {
  it('groups in lakh style: three digits, then twos', () => {
    expect(moneyExact(0)).toBe('Rs 0');
    expect(moneyExact(999)).toBe('Rs 999');
    expect(moneyExact(2500)).toBe('Rs 2,500');
    expect(moneyExact(250000)).toBe('Rs 2,50,000');
    expect(moneyExact(12345678)).toBe('Rs 1,23,45,678');
  });

  it('shows paisa only when there are some, and never rounds rupees away', () => {
    expect(moneyExact(1250.5)).toBe('Rs 1,250.50');
    expect(moneyExact(1250.004)).toBe('Rs 1,250');
    expect(moneyExact(-3500)).toBe('-Rs 3,500');
    expect(moneyExact(Number.NaN)).toBe('—');
  });
});