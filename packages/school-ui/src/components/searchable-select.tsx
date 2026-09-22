'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface SelectOption { value: string; label: string }

/**
 * A type-to-filter replacement for a plain `<select>` whose option list has grown long (#16 — the
 * section and exam pickers list every section/exam in the school, which reached ~94 entries and
 * became an un-scrollable wall). The options are already in the browser, so this filters them
 * client-side — no request per keystroke, unlike the server-backed StudentPicker.
 *
 * It stays a real combobox: ↑/↓ move, Enter picks, Escape closes, the match count is announced, and
 * the whole list shows on focus so it still behaves like a dropdown when you just want to browse.
 * Clearing the box and blurring selects "nothing" (for optional filters).
 */
export function SearchableSelect({ id, value, onChange, options, placeholder = 'Search…', emptyLabel = 'No match.' }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  emptyLabel?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const selected = options.find((o) => o.value === value) ?? null;
  const [text, setText] = useState(selected?.label ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typing, setTyping] = useState(false); // true once the user edits, so the list filters
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the box in sync when the value is changed from outside (e.g. the form resets on report change).
  useEffect(() => { setText(selected?.label ?? ''); setTyping(false); }, [selected?.label]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!typing || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, text, typing]);

  function pick(o: SelectOption) {
    onChange(o.value);
    setText(o.label);
    setTyping(false);
    setOpen(false);
  }
  function close() {
    // Revert an unfinished search to the current selection so the box never lies about `value`.
    setText(selected?.label ?? '');
    setTyping(false);
    setOpen(false);
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTyping(true);
          setOpen(true);
          setActive(0);
          if (e.target.value.trim() === '' && value) onChange(''); // cleared → deselect
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => { if (!rootRef.current?.contains(document.activeElement)) close(); }, 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && open && filtered[active]) { e.preventDefault(); pick(filtered[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
      />
      <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {open ? `${filtered.length} option${filtered.length === 1 ? '' : 's'}` : ''}
      </span>

      {open && (
        <ul id={listId} role="listbox" className="card"
          style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, top: 'calc(100% + 4px)', margin: 0, padding: 4, listStyle: 'none', maxHeight: 280, overflowY: 'auto' }}>
          {filtered.length === 0 && <li className="muted" style={{ padding: '6px 8px', fontSize: 13 }}>{emptyLabel}</li>}
          {filtered.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
              style={{ padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: i === active ? 'var(--bg-muted, #f1f5f9)' : undefined }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
