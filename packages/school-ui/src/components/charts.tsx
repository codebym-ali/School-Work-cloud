/**
 * The dashboard's two charts.
 *
 * **Plain HTML and CSS, not SVG and not a charting library.**
 *
 * No library: this app has no Tailwind and no component framework — one stylesheet and a small
 * semantic class vocabulary — and a charting dependency would be the largest thing in the bundle
 * by an order of magnitude, for two figures.
 *
 * ⚠️ **Not SVG either, and that was a correction.** Both of these forms are boxes: a stacked bar
 * is one row of widths, a column chart is one row of heights. Drawn in a `viewBox` they looked
 * right on a laptop and failed on a phone — **the peak label measured 7px tall at 375px**, because
 * a viewBox scales its own text down with the width, and 21 units of a 1000-unit box is 6.6px once
 * that box is 314px wide. Nothing in the markup was wrong; the medium was. In HTML the type is
 * real CSS pixels at every width, which is the whole reason to prefer it for rectangular forms.
 *
 * ## The colours are computed, not chosen
 *
 * ⚠️ **The obvious palette is unreadable, and it is the one the reference site uses.** Painting
 * the register green/red/orange/blue was measured against the Machado–Oliveira–Fernandes CVD model:
 *
 *   · absent `#e40014` ↔ present `#00a544` — **ΔE 5.3 under deuteranopia**, below even the
 *     conditional floor of 6. Present-versus-absent is the most important distinction on a school
 *     register, and to a deuteranope those two bands were the same colour.
 *   · late `#f05100` ↔ absent `#e40014` — **ΔE 8.8 under NORMAL vision**, below the floor of 15.
 *     Orange beside red is hard for everyone, not only for colour-blind readers.
 *
 * Two changes fixed it, both measured rather than judged:
 *   1. **Order the bands so red and green never touch** — `leave` (blue) sits between them. Only
 *      neighbours need to separate, so segment order is a real accessibility control.
 *   2. **Step `late` down to `#c2410c`**, lifting the worst adjacent pair to ΔE 7.2 (deutan) and
 *      30.0 (normal), with every band still clearing 3:1 against white.
 *
 * ΔE 7.2 sits in the 6–8 band, which is legal **only** with secondary encoding — so the 2px gaps
 * and the always-present labelled legend are load-bearing, not decoration. Remove either and this
 * chart stops being compliant.
 *
 * ⚠️ These are NOT the `--ok` / `--warn` / `--danger` badge tokens and must not be "tidied" into
 * them. Those are a text-on-tint pair solving a 4.5:1 *text* problem; these are fills solving a
 * mark-*separation* problem. Same meanings, different jobs, different constraints.
 */

const CHART = {
  present: '#00a544',
  late: '#c2410c',
  leave: '#155dfc',
  absent: '#e40014',
  /** Not a status — the registers nobody has filled in. Grey has no chroma, so it cannot be
   *  confused with a status band under any form of colour vision. 3.36:1 on white. */
  unmarked: '#828d9e',
} as const;

// ─── Today's register ────────────────────────────────────────────────────────────────────────

export interface RegisterBreakdown {
  present: number; late: number; leave: number; absent: number; unmarked: number;
}

/**
 * Part-to-whole, so: **one horizontal stacked bar**, not five tiles and not a pie.
 *
 * ⚠️ **`unmarked` is a band, not an omission.** A register with one child marked and sixteen
 * blank plots as "100% present" if you show only what exists — which is exactly the reassuring
 * lie the percentage on this dashboard already carries a coverage line to defuse. Here it would
 * be structural: a part-to-whole chart *claims* its parts sum to the whole, so the unaccounted
 * remainder has to be one of the parts or the picture is false.
 */
export function RegisterBar({ b }: { b: RegisterBreakdown }) {
  const bands = [
    { key: 'present', label: 'Present', v: b.present, c: CHART.present },
    { key: 'late', label: 'Late', v: b.late, c: CHART.late },
    { key: 'leave', label: 'On leave', v: b.leave, c: CHART.leave },
    { key: 'absent', label: 'Absent', v: b.absent, c: CHART.absent },
    { key: 'unmarked', label: 'Not marked', v: b.unmarked, c: CHART.unmarked },
  ].filter((s) => s.v > 0);

  const total = bands.reduce((n, s) => n + s.v, 0);
  if (!total) return <p className="muted" style={{ margin: 0 }}>No register expected today.</p>;

  return (
    <figure className="chart">
      {/* `flex` with a gap gives the mandated 2px surface separation for free, and — unlike a
          stroke around each band — it takes the space out of the row rather than adding ink. */}
      <div className="bar-stack" role="img"
           aria-label={`Today's register, ${total} children: ${bands.map((s) => `${s.label} ${s.v}`).join(', ')}`}>
        {bands.map((s) => (
          <span key={s.key} className="seg" style={{ flexGrow: s.v, background: s.c }}
                title={`${s.label}: ${s.v} of ${total} (${Math.round((s.v / total) * 100)}%)`} />
        ))}
      </div>
      {/* Always present, and carrying the value: identity is never colour-alone, and this is the
          secondary encoding that makes the 7.2 adjacent pair legal. It doubles as the table view. */}
      <ul className="chart-legend">
        {bands.map((s) => (
          <li key={s.key}>
            <span className="sw" style={{ background: s.c }} />
            <span className="k">{s.label}</span>
            <span className="v">{s.v}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

// ─── Collections trend ───────────────────────────────────────────────────────────────────────

export interface TrendPoint { month: string; collected: number; }

/**
 * Change over time, one series → **columns in a single hue**, and therefore **no legend box**:
 * with one colour there is nothing to disambiguate and a one-swatch legend only restates the
 * panel title.
 *
 * A single month's total says "how much" but never "is this normal" — and "is this normal" is the
 * only question a headline figure on a dashboard can usefully raise. Six columns turn
 * `Rs 90,000` from a fact into a judgement.
 *
 * **Emphasis, not category:** the peak wears `--brand` and the rest a lighter step of the same
 * hue. Giving each month its own colour would spend the identity channel re-encoding what the
 * column heights already say.
 */
export function CollectionsTrend({ points, money }: { points: TrendPoint[]; money: (v: number) => string }) {
  if (!points.length) return <p className="muted" style={{ margin: 0 }}>No collections recorded yet.</p>;

  const max = Math.max(...points.map((p) => p.collected));
  const peak = points.reduce((a, p) => (p.collected >= a.collected ? p : a), points[0]);
  const allZero = max <= 0;

  return (
    <figure className="chart">
      <div className="columns" role="img"
           aria-label={`Collections by month: ${points.map((p) => `${monthLabel(p.month)} ${money(p.collected)}`).join(', ')}`}>
        {points.map((p) => {
          const isPeak = !allZero && p.month === peak.month;
          return (
            <div key={p.month} className="col" title={`${monthLabel(p.month)}: ${money(p.collected)}`}>
              {/* Label the peak only. A number on every column is chaos and goes unread; the
                  others are carried by the tooltip and by the total printed beside this chart. */}
              <span className="peak">{isPeak ? money(p.collected) : ' '}</span>
              <div className="track">
                {/* `max` can be 0 for a school with no payments yet — every column is then a true
                    zero and the row is flat, which is the honest picture rather than a divide. */}
                <div className={`fill${isPeak ? ' is-peak' : ''}`}
                     style={{
                       height: allZero ? 0 : `${(p.collected / max) * 100}%`,
                       // ⚠️ The 2px floor exists so a small month is not invisible — but it must NOT
                       // apply to a true zero, or a month that collected nothing draws a stub and
                       // reads as "a little". Zero gets zero height; only a real value gets rescued.
                       minHeight: p.collected > 0 ? 2 : 0,
                     }} />
              </div>
              <span className="tick">{monthLabel(p.month)}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** `2026-08` → `Aug`. Sliced, never `new Date('2026-08')` — that parses as UTC midnight and
 *  renders as the PREVIOUS month anywhere west of Greenwich. */
function monthLabel(ym: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
}
