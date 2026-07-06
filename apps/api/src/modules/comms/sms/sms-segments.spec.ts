import { computeSegments, renderTemplate } from './sms-segments';

describe('SMS segmentation (§14)', () => {
  it('counts GSM-7 single and multipart segments', () => {
    expect(computeSegments('Hello')).toMatchObject({ encoding: 'GSM7', segments: 1 });
    expect(computeSegments('a'.repeat(160))).toMatchObject({ encoding: 'GSM7', segments: 1 });
    expect(computeSegments('a'.repeat(161))).toMatchObject({ encoding: 'GSM7', segments: 2 });
    expect(computeSegments('a'.repeat(306))).toMatchObject({ segments: 2 }); // 306/153 = 2
    expect(computeSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('treats GSM-7 extended chars (e.g. {}) as two units', () => {
    // 79 base 'a' + '{' (2 units) = 81 units -> still 1 segment; 159 'a' + '{' = 161 -> 2
    expect(computeSegments('a'.repeat(159) + '{').segments).toBe(2);
  });

  it('falls back to UCS-2 for non-GSM (Urdu) text with 70/67 boundaries', () => {
    const urdu = 'سلام'; // non-GSM
    expect(computeSegments(urdu).encoding).toBe('UCS2');
    expect(computeSegments('ش'.repeat(70))).toMatchObject({ encoding: 'UCS2', segments: 1 });
    expect(computeSegments('ش'.repeat(71)).segments).toBe(2);
  });

  it('renders {placeholders} and leaves unknown tokens intact', () => {
    expect(renderTemplate('Hi {name}, on {date}', { name: 'Sara', date: '2026-03-10' })).toBe(
      'Hi Sara, on 2026-03-10',
    );
    expect(renderTemplate('Hi {name} {missing}', { name: 'Ali' })).toBe('Hi Ali {missing}');
  });
});
