'use client';

import { useEffect, useId, useRef, useState } from 'react';

export interface RowAction {
  label: string;
  onSelect: () => void;
  /** Destructive — rendered red and separated, so it is never the item a hurried click lands on. */
  danger?: boolean;
  hidden?: boolean;
  disabled?: boolean;
}

/**
 * One "⋯" menu per row instead of four buttons on every row (Owner UX plan, Phase 1a / principle 4 — calm by
 * default). Thirty rows × "View / Change status / Move / Delete" is a wall of equal-weight buttons with a red
 * Delete one slip away; here the row itself opens the record and the rest waits behind one control.
 *
 * Accessible menu-button: Enter/Space/↓ opens and focuses the first item, ↑/↓ move, Escape closes and returns
 * focus to the trigger, a click outside closes. Clicks never bubble to the row (which opens the drawer).
 */
export function RowActions({ actions, label = 'More actions' }: { actions: RowAction[]; label?: string }) {
  const visible = actions.filter((a) => !a.hidden);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    items.current.find((b) => b && !b.disabled)?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!visible.length) return null;
  // Safe actions first, destructive ones last and set apart.
  const ordered = [...visible.filter((a) => !a.danger), ...visible.filter((a) => a.danger)];

  const move = (from: number, step: number) => {
    const enabled = items.current.map((b, i) => (b && !b.disabled ? i : -1)).filter((i) => i >= 0);
    if (!enabled.length) return;
    const at = enabled.indexOf(from);
    items.current[enabled[(at + step + enabled.length) % enabled.length]]?.focus();
  };
  const close = () => { setOpen(false); trigger.current?.focus(); };

  return (
    <div className="ov-actions" ref={wrap} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button ref={trigger} type="button" className="ov-actions-btn" aria-label={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div id={menuId} role="menu" className="ov-menu"
          onKeyDown={(e) => {
            const i = items.current.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
            else if (e.key === 'Tab') setOpen(false);
          }}>
          {ordered.map((a, i) => (
            <button key={a.label} ref={(el) => { items.current[i] = el; }} type="button" role="menuitem"
              className={`ov-menu-item${a.danger ? ' is-danger' : ''}${a.danger && i > 0 && !ordered[i - 1].danger ? ' is-separated' : ''}`}
              disabled={a.disabled}
              onClick={() => { setOpen(false); a.onSelect(); }}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
