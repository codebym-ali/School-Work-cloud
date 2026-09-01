'use client';

import { Icon } from '@sw/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type NotificationItem } from '@sw/api-client';

/**
 * "What changed for me", in the app-shell topbar (Notifications Plan, N1).
 *
 * **It lives in the shell, not on a dashboard, for the same reason the closure banner does.**
 * `/dashboard` — and the "Needs attention" strip on it — is OWNER_ADMIN / CAMPUS_ADMIN /
 * ACCOUNTANT only. A teacher lands on `/attendance`, staff on `/my-attendance`. Hanging this off
 * a dashboard would miss exactly the people it was built for.
 *
 * **Silent when there is nothing to say.** The button does not render at all on an empty list,
 * rather than sitting there as a permanent grey zero. A control that is always present and always
 * says nothing trains people not to look at it — the same reasoning that keeps the closure banner
 * to today and tomorrow.
 *
 * The count comes from the same response as the list, never a second call: a bell reading 3 that
 * opens onto 2 items is worse than no bell.
 */
export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // Fails silently. A notification bell is never worth breaking the page around it, and every
    // role hits this on every navigation — including accounts with nothing to be told.
    try {
      const res = await api.notifications.list();
      setItems(res.items);
      setUnread(res.unread);
    } catch { /* leave the bell hidden */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close on an outside click or Escape — a panel that traps you is worse than no panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items.length) return null;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || unread === 0) return;
    // Clear the badge as soon as it is opened — the person is looking at them now. Optimistic so
    // the badge does not linger through a round trip; the server is the record either way.
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, isNew: false })));
    await api.notifications.seen().catch(() => { /* the next load will correct it */ });
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="ghost small"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
      >
        <Icon name="bell" size={17} />{unread > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{unread}</span>}
      </button>

      {open && (
        <div
          className="card stack"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50,
            width: 'min(360px, calc(100vw - 32px))', gap: 8, maxHeight: 420, overflowY: 'auto',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.15)',
          }}
        >
          <div className="section-title" style={{ margin: 0 }}>What changed for you</div>
          {items.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              onClick={() => setOpen(false)}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div className="stack" style={{ gap: 2, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: n.isNew ? 600 : 400 }}>
                  {n.severity === 'warn' ? '⚠️ ' : ''}{n.text}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>{relativeDay(n.at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Today" / "Yesterday" / a date. Nobody needs a timestamp to the second for this. */
function relativeDay(at: string): string {
  const then = new Date(at);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
