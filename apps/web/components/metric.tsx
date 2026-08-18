import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The three shapes a headline number can take.
 *
 * ⚠️ **The product already had two of these and used them on two screens.** `.metric-link` has been
 * in `globals.css` since the retheme — hover, focus-visible, and a documented `.metric.metric-link`
 * variant — and `/staff-attendance` and `/dashboard` each grew their own local component around it.
 * Meanwhile **31 tiles on ten other screens stayed plain `<div>`s**: the right number, shown
 * prominently, with no way to reach the rows behind it. This file is that component, in one place,
 * so the next screen inherits the behaviour instead of reinventing or forgetting it.
 *
 * ### A tile is an entry point, or it is context — and it must look like which
 *
 * Not every number has rows behind it. "Conversion rate" is a ratio; "Attendance 94%" is a
 * derivation. Making those clickable would be worse than leaving them alone, because a tile that
 * lifts under the cursor and then does nothing teaches people to stop trying the ones that work.
 *
 * So: `MetricLink` and `MetricFilter` for numbers you can walk into, `Metric` for numbers that are
 * only there to be read. The distinction is deliberate and visible — never an oversight.
 */

interface Common {
  label: ReactNode;
  value: ReactNode;
  /** Draws attention: something here needs a person. */
  alert?: boolean;
}

/** A number with nothing behind it — a ratio, an average, a percentage. Reads, does not navigate. */
export function Metric({ label, value, alert }: Common) {
  return (
    <div className={`metric${alert ? ' metric-alert' : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

/** A number whose rows live on another screen. */
export function MetricLink({ label, value, alert, href, title }: Common & { href: string; title?: string }) {
  return (
    <Link href={href} title={title} className={`metric metric-link${alert ? ' metric-alert' : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </Link>
  );
}

/**
 * A count that IS its own filter — the rows are already on this screen.
 *
 * ⚠️ **Bind the number and the filter to the same predicate.** Lifted from `/staff-attendance`,
 * which learned it the hard way: a "Present" tile that quietly counted late arrivals sat beside a
 * PRESENT filter that did not, so the page said 1 and then showed nothing when you clicked it. If
 * the tile and the filter are derived from one expression, that cannot happen — as opposed to being
 * fixed once and free to drift again.
 */
export function MetricFilter({ label, value, alert, active, title, onClick }: Common & {
  active: boolean; title?: string; onClick: () => void;
}) {
  return (
    // ⚠️ No `is-active` class: `button.metric-link[aria-pressed='true']` is already styled in
    // globals.css. A second class for the same state is the duplication this whole plan is about,
    // and it would drift the first time one of them was restyled.
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
      className={`metric metric-link${alert ? ' metric-alert' : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </button>
  );
}
