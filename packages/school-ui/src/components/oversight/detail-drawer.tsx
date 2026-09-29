'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * The record opens BESIDE the list, not instead of it (Owner UX plan, Phase 1a / principle 2 — summary →
 * slice → record). A director checking five students keeps their filtered list, scroll position and page;
 * closing the drawer puts them exactly where they were.
 *
 * Modal dialog: `role="dialog"` + `aria-modal`, labelled by its title; focus moves to the close button on
 * open, is kept inside while open (Tab wraps), Escape or a backdrop click closes, and focus returns to
 * whatever opened it. The page behind stops scrolling. Full-width on a phone.
 */
export function DetailDrawer({ open, onClose, title, subtitle, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  // Held in a ref so the effect below depends on `open` ONLY. Callers pass inline arrows; if the effect
  // re-ran on every render it would yank focus back to the close button and flicker the scroll lock.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onClose = () => onCloseRef.current();
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const f = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ov-drawer-root">
      <div className="ov-drawer-backdrop" onClick={onClose} aria-hidden />
      <div ref={panel} className="ov-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ov-drawer-head">
          <div className="ov-drawer-titles">
            <h2 id={titleId} className="ov-drawer-title">{title}</h2>
            {subtitle && <p className="ov-drawer-sub">{subtitle}</p>}
          </div>
          <button ref={closeBtn} type="button" className="ov-drawer-close" aria-label="Close" onClick={onClose}>
            <span aria-hidden>✕</span>
          </button>
        </header>
        <div className="ov-drawer-body">{children}</div>
        {footer && <footer className="ov-drawer-foot">{footer}</footer>}
      </div>
    </div>
  );
}
