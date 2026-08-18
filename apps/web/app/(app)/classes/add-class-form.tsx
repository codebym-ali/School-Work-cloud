'use client';

import { useState } from 'react';
import type { Campus, Klass, Subject } from '@/lib/api';

/**
 * Add a class — the page's primary action, so it sits at the top.
 *
 * Two things once made this actively misleading and are deliberately preserved as fixed:
 *  - the placeholder was `9th`, which reads as a filled-in value (and 9th usually already
 *    exists), so people clicked Add class and nothing happened. It is `e.g. 9th`.
 *  - the reason the button was disabled sat to the RIGHT of the button, where nobody looks.
 *    It sits under the field it refers to.
 *
 * ⚠️ This is NOT gated on any "show advanced tools" flag. School configuration no longer
 * embeds class management at all, so this form is the only way a brand-new school creates its
 * first class — hiding it behind a threshold would lock a new school out entirely.
 */
export function AddClassForm({ campuses, classes, subjects, onCreate, defaultCampusId }: {
  campuses: Campus[];
  /** Pre-selects the campus the director is lensed into; the select stays editable. */
  defaultCampusId?: string;
  classes: Klass[];
  subjects: Subject[];
  onCreate: (body: { campusId: string; name: string; order: number }, copySubjectsFrom: string | null) => Promise<string | null>;
}) {
  const [campusId, setCampusId] = useState(defaultCampusId ?? '');
  const [name, setName] = useState('');
  // 9th and 10th usually share most of their subjects — retyping them per class is the most
  // tedious part of setting up a school, so a new class can inherit an existing list.
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);

  const targetCampus = campusId || (campuses.length === 1 ? campuses[0].id : '');
  const blocker = !targetCampus ? 'Choose a campus first.' : !name.trim() ? 'Enter a class name to continue.' : null;

  // "Order" decides the sort position of a class — and which class a student is promoted INTO
  // at year end. It is a developer-facing number, so it is assigned automatically rather than
  // asked of a school admin.
  const nextOrder = (cid: string) => {
    const inCampus = classes.filter((k) => k.campusId === cid);
    return inCampus.length ? Math.max(...inCampus.map((k) => k.order)) + 1 : 1;
  };

  async function submit() {
    if (blocker || busy) return;
    setBusy(true);
    try {
      const failure = await onCreate({ campusId: targetCampus, name: name.trim(), order: nextOrder(targetCampus) }, copyFrom || null);
      if (!failure) setName('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" style={{ background: '#f8fafc', padding: '14px 16px' }}>
      <strong style={{ fontSize: 14 }}>Add a class</strong>
      <div className="inline-form" style={{ alignItems: 'flex-start' }}>
        {campuses.length > 1 && (
          <div>
            <label>Campus</label>
            <select value={campusId} onChange={(e) => setCampusId(e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ minWidth: 180 }}>
          <label>Class name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 9th"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          />
          {blocker && <div className="field-hint">{blocker}</div>}
        </div>
        {classes.length > 0 && (
          <div>
            <label>Copy subjects from</label>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">Start with none</option>
              {classes.map((c) => {
                const n = subjects.filter((s) => s.classId === c.id).length;
                return (
                  <option key={c.id} value={c.id} disabled={n === 0}>
                    {c.name}{n ? ` (${n} subject${n === 1 ? '' : 's'})` : ' — no subjects'}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        <button type="button" disabled={Boolean(blocker) || busy} onClick={() => void submit()}>
          {busy ? 'Adding…' : 'Add class'}
        </button>
      </div>
    </div>
  );
}
