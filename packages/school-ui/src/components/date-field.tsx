'use client';

/**
 * The one date control for school screens (Owner UX Phase 2).
 *
 * The native `<input type="date">` stays underneath — it brings the platform's calendar, keyboard entry and
 * screen-reader support for free — but on its own it renders in the BROWSER'S locale (MM/DD/YYYY on a US
 * machine) and never says the weekday, which is the first thing a school asks of a date ("was that a
 * Friday?"). So the chosen day is spelled out beside it the way the school writes it — "Mon, 29/09/2026" —
 * and ‹ › step one day at a time, which is how a register is actually walked.
 *
 * Values are ISO `YYYY-MM-DD` strings throughout; the readout is display only.
 */
export function formatSchoolDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const [y, m, day] = iso.split('-');
  return `${weekday}, ${day}/${m}/${y}`;
}

function weekdayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function DateField({ id, value, onChange, min, max, label, stepper = true }: {
  id: string;
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  /** Visible label; omit when the caller renders its own <label htmlFor={id}>. */
  label?: string;
  /** ‹ › day buttons — right for a register or a daily report, noise for a birth date. */
  stepper?: boolean;
}) {
  const canPrev = !!value && (!min || shift(value, -1) >= min);
  const canNext = !!value && (!max || shift(value, 1) <= max);
  const dayName = weekdayLabel(value);
  return (
    <div className="date-field">
      {label && <label htmlFor={id}>{label}</label>}
      <div className="date-field-row">
        {stepper && (
          <button type="button" className="date-step" aria-label="Previous day" disabled={!canPrev} onClick={() => onChange(shift(value, -1))}>‹</button>
        )}
        <input id={id} type="date" value={value} min={min} max={max}
          aria-describedby={dayName ? `${id}-readout` : undefined}
          onChange={(e) => e.target.value && onChange(e.target.value)} />
        {stepper && (
          <button type="button" className="date-step" aria-label="Next day" disabled={!canNext} onClick={() => onChange(shift(value, 1))}>›</button>
        )}
      </div>
      {dayName && <span id={`${id}-readout`} className="date-field-readout">{dayName}</span>}
    </div>
  );
}
