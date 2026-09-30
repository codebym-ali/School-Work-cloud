'use client';

import { useRef, type KeyboardEvent } from 'react';

/** Segmented tab bar with the keyboard behaviour a tablist promises: ←/→ move, Home/End jump, one tab stop. */
export function ProfileTabs<K extends string>({ tabs, value, onChange, label }: {
  tabs: Array<{ key: K; label: string }>; value: K; onChange: (k: K) => void; label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label}
      style={{ display: 'flex', gap: 4, background: '#edf0f5', padding: 4, borderRadius: 10, overflowX: 'auto', maxWidth: '100%' }}>
      {tabs.map((t, i) => (
        <button key={t.key} type="button" role="tab" ref={(el) => { refs.current[i] = el; }}
          aria-selected={value === t.key} tabIndex={value === t.key ? 0 : -1}
          className={`ov-tab${value === t.key ? ' is-active' : ''}`} style={{ whiteSpace: 'nowrap' }}
          onClick={() => onChange(t.key)} onKeyDown={(e) => move(e, i)}>{t.label}</button>
      ))}
    </div>
  );
}
