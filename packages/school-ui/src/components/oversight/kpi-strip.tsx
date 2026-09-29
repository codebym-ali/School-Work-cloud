import type { ReactNode } from 'react';
import { Icon, type IconName } from '@sw/ui';
import type { Tone } from './status-pill';

export interface KpiTileSpec {
  key: string;
  label: string;
  /** `undefined` renders a skeleton — a missing number is "loading", never a misleading 0. */
  value: ReactNode | undefined;
  /** One short line under the value: a delta, a share, a hint ("of 312", "3 more than yesterday"). */
  sub?: ReactNode;
  tone?: Tone;
  icon?: IconName;
  /** Principle 3 — every number is a door: clicking filters the list below. Omit for a read-only figure. */
  onClick?: () => void;
  /** The tile's filter is the one applied now. */
  active?: boolean;
  /** Plain-language explanation shown as the tooltip and to screen readers. */
  hint?: string;
}

/**
 * The headline strip at the top of every owner screen (Owner UX plan, Phase 1a): the 4–8 numbers a
 * director reads first, each one a filter for the table beneath it.
 *
 * ⚠️ Clickable tiles are real <button>s (keyboard + screen reader) with `aria-pressed` for the applied
 * filter. They are styled as SURFACES, so the stylesheet carries an explicit `button.ov-kpi:hover` rule —
 * the global navy `button:hover` otherwise wins and makes the text unreadable (the Phase 0.2 bug).
 */
export function KpiStrip({ tiles, label = 'Summary' }: { tiles: KpiTileSpec[]; label?: string }) {
  return (
    <div className="ov-kpis" role="group" aria-label={label}>
      {tiles.map(({ key, ...t }) => <KpiTile key={key} {...t} />)}
    </div>
  );
}

function KpiTile({ label, value, sub, tone = 'neutral', icon, onClick, active, hint }: Omit<KpiTileSpec, 'key'>) {
  const inner = (
    <>
      <span className="ov-kpi-head">
        <span className="ov-kpi-label">{label}</span>
        {icon && <span className={`ov-kpi-ico is-${tone}`} aria-hidden><Icon name={icon} size={16} /></span>}
      </span>
      {value === undefined
        ? <span className="ov-skel ov-kpi-skel" aria-label="Loading" />
        : <span className={`ov-kpi-value is-${tone}`}>{value}</span>}
      {sub !== undefined && <span className="ov-kpi-sub">{sub}</span>}
    </>
  );
  if (!onClick) return <div className="ov-kpi" title={hint}>{inner}</div>;
  return (
    <button type="button" className={`ov-kpi is-clickable${active ? ' is-active' : ''}`}
      aria-pressed={!!active} title={hint} onClick={onClick}>
      {inner}
    </button>
  );
}
