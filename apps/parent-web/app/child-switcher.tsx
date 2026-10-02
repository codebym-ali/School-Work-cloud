'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type PortalChild } from '@sw/api-client';

export function ChildSwitcher({ onSwitch }: { onSwitch?: () => void }) {
  const [children, setChildren] = useState<PortalChild[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await api.parentPortal.children();
      setChildren(list);
    } catch { /* silent — switcher is additive */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (children.length <= 1) return null;

  async function switchTo(id: string) {
    try {
      const updated = await api.parentPortal.switchChild(id);
      setChildren(updated);
      onSwitch?.();
    } catch { /* toast would be better but we keep it simple */ }
  }

  return (
    <div className="child-switcher" role="radiogroup" aria-label="Switch child">
      {children.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`child-chip${c.isCurrent ? ' active' : ''}`}
          role="radio"
          aria-checked={c.isCurrent}
          onClick={() => !c.isCurrent && switchTo(c.id)}
          title={`${c.fullName} — ${c.className ?? 'No class'}`}
        >
          {c.photoUrl ? (
            <img src={c.photoUrl} alt="" className="child-avatar" />
          ) : (
            <span className="child-avatar child-avatar--fallback">{initials(c.fullName)}</span>
          )}
          <span className="child-name">{firstName(c.fullName)}</span>
        </button>
      ))}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0]?.[0] ?? '').toUpperCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
