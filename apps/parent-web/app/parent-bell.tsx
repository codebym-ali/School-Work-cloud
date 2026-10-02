'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type NotificationItem } from '@sw/api-client';
import { Icon } from '@sw/ui';

/**
 * Notification bell for the parent portal.
 *
 * Its own component against its own endpoint, deliberately not the staff `NotificationBell`.
 * That one calls `/notifications`, which is role-gated and would 403 for a portal session.
 * Silent when empty, like the staff bell.
 */
export function ParentBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // Fails silently. A bell is never worth breaking the portal around.
    try {
      const res = await api.portal.notifications();
      setItems(res.items);
      setUnread(res.unread);
    } catch { /* leave the bell hidden */ }
  }, []);

  useEffect(() => { load(); }, [load]);

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
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, isNew: false })));
    await api.portal.notificationsSeen().catch(() => { /* the next load corrects it */ });
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
        <Icon name="bell" size={16} />{unread > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{unread}</span>}
      </button>

      {open && (
        <div
          className="card stack"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50,
            width: 'min(340px, calc(100vw - 32px))', gap: 8, maxHeight: 400, overflowY: 'auto',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.15)',
          }}
        >
          <div className="section-title" style={{ margin: 0 }}>What changed for you</div>
          {items.map((n) => (
            <Link key={n.id} href={n.href} onClick={() => setOpen(false)} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="stack" style={{ gap: 2, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: n.isNew ? 600 : 400 }}>
                  {n.severity === 'warn' && <><Icon name="alert" size={14} />{' '}</>}{n.text}
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

/** A closure is "Tomorrow" as often as "Today", so this counts forwards as well as back. */
function relativeDay(at: string): string {
  const then = new Date(at);
  const days = Math.round((then.getTime() - Date.now()) / 86400000);
  if (days >= 1) return 'Tomorrow';
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days > -7) return `${-days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
