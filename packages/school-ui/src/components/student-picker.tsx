'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api, type ReportStudentOption } from '@sw/api-client';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/**
 * Find a student by name or GR number (plan foundation F2).
 *
 * Replaces free-text boxes that asked for a student's UUID — a value no screen in the product ever shows.
 *
 * ⚠️ **Two protections, and both are needed.** The debounce stops a request per keystroke. The
 * AbortController stops an OLD response overwriting a NEW one: typing "Al" then "Ali" sends two requests,
 * and if the first is slower it arrives second — without cancellation, the list shows Al's results under
 * the word "Ali". Debouncing only narrows that window; cancelling closes it.
 *
 * Keyboard: ↑/↓ move, Enter picks, Escape closes. The result count is announced to screen readers.
 */
export function StudentPicker({ id, value, onChange, campusId }: {
  id?: string;
  value: ReportStudentOption | null;
  onChange: (student: ReportStudentOption | null) => void;
  campusId?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const [text, setText] = useState(value ? `${value.fullName} (${value.grNumber})` : '');
  const [options, setOptions] = useState<ReportStudentOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    // Picking an option fills the box with its label; that is not a new search.
    if (value && text === `${value.fullName} (${value.grNumber})`) return;
    const term = text.trim();
    if (term.length < MIN_CHARS) { setOptions([]); setSearching(false); return; }

    const timer = window.setTimeout(async () => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setSearching(true);
      try {
        const found = await api.reportLookups.students(term, controller.signal, campusId);
        if (!controller.signal.aborted) { setOptions(found); setActive(0); setOpen(true); }
      } catch {
        // An aborted request is the expected outcome of typing on; a real failure leaves the list empty.
        if (!controller.signal.aborted) setOptions([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, value, campusId]);

  useEffect(() => () => inflight.current?.abort(), []);

  function pick(s: ReportStudentOption) {
    onChange(s);
    setText(`${s.fullName} (${s.grNumber})`);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Type a name or GR number"
        value={text}
        onChange={(e) => { setText(e.target.value); if (value) onChange(null); }}
        onFocus={() => options.length > 0 && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); pick(options[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {/* Visually hidden, still announced. There is no shared sr-only class in this app, so it is inline. */}
      <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {searching ? 'Searching' : open ? `${options.length} student${options.length === 1 ? '' : 's'} found` : ''}
      </span>

      {open && text.trim().length >= MIN_CHARS && (
        <ul id={listId} role="listbox" className="card"
          style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, top: 'calc(100% + 4px)', margin: 0, padding: 4, listStyle: 'none', maxHeight: 280, overflowY: 'auto' }}>
          {options.length === 0 && !searching && <li className="muted" style={{ padding: '6px 8px', fontSize: 13 }}>No student matches.</li>}
          {options.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
              style={{ padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: i === active ? 'var(--bg-muted, #f1f5f9)' : undefined }}>
              <strong>{s.fullName}</strong> <span className="muted">· {s.grNumber}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {s.placement ?? 'No class'}{!s.isActive && ' · left the school'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
