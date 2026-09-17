'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api, apiGet, ApiError, type AcademicYear, type Campus, type PromotionPreview, type PromotionResultBody,
} from '@sw/api-client';
import { FEE_CLEARANCE_OVERRIDE_ROLES, hasAnyRole, isSchoolWideAdmin } from '@sw/roles';
import { useMe } from '@sw/session';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

type Choice = 'PROMOTE' | 'RETAIN' | 'WITHDRAW';

const OUTCOME: Record<string, { label: string; tone: string }> = {
  PROMOTED: { label: 'Promoted', tone: 'ok' },
  RETAINED: { label: 'Retained', tone: 'warn' },
  WITHDRAWN: { label: 'Leaving', tone: '' },
  COMPLETED: { label: 'Completes school', tone: 'ok' },
};

/**
 * Year-end promotion (GAP-03): choose the new year, review every section, mark exceptions, then promote.
 *
 * The largest operation in a school's calendar had an endpoint and no screen.
 *
 * ⚠️ **Nothing is written until "Promote".** The preview is exactly what will happen. Changing any student's
 * choice makes it stale, and Promote stays disabled until the preview is refreshed — the fingerprint the
 * server checks must be of the list on screen, not of a list the owner has since edited.
 *
 * ⚠️ **Blocked students are listed first**, not scattered through forty sections: they are the only rows that
 * need a decision, and a school should see them before, not after, it promotes everyone else.
 */
export default function PromotionPage() {
  const me = useMe();
  const schoolWide = isSchoolWideAdmin(me?.roles);
  const canOverride = hasAnyRole(me?.roles, FEE_CLEARANCE_OVERRIDE_ROLES);

  const [years, setYears] = useState<AcademicYear[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campusId, setCampusId] = useState('');
  const [targetYearId, setTargetYearId] = useState('');
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [overrideFees, setOverrideFees] = useState(false);
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<PromotionResultBody | null>(null);

  useEffect(() => {
    apiGet<AcademicYear[]>('/academic-years').then(setYears).catch(() => {});
    apiGet<Campus[]>('/campuses').then((c) => {
      setCampuses(c);
      // A campus admin has one campus; the API forces it anyway.
      const own = me?.campusId ?? c[0]?.id ?? '';
      setCampusId((cur) => cur || own);
    }).catch(() => {});
  }, [me?.campusId]);

  const current = years.find((y) => y.isCurrent);
  // Only a year that starts after the current one can be promoted INTO.
  const targets = years.filter((y) => !y.isCurrent && (!current || y.startDate > current.startDate));

  async function runPreview() {
    if (!campusId || !targetYearId) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      setPreview(await api.promotions.plan(body()));
      setStale(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not build the promotion list.');
    } finally { setBusy(false); }
  }

  const body = () => ({
    targetYearId,
    campusId,
    overrides: [...choices].filter(([, c]) => c !== 'PROMOTE').map(([studentId, c]) => ({ studentId, action: c === 'RETAIN' ? 'RETAINED' as const : 'WITHDRAWN' as const })),
    ...(overrideFees ? { overridePreconditions: true } : {}),
  });

  const choose = (studentId: string, c: Choice) => {
    setChoices((cur) => new Map(cur).set(studentId, c));
    setStale(true);
  };

  const blocked = useMemo(() => (preview?.sections ?? []).flatMap((s) => s.lines.filter((l) => l.blocked).map((l) => ({ ...l, section: s.label }))), [preview]);
  const t = preview?.totals;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Year-end promotion</h1>
        <p className="muted" style={{ margin: 0 }}>Move every student into next year&apos;s class. Review the list first — nothing changes until you promote.</p>
      </div>

      <div className="card stack" style={{ gap: 10 }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, alignItems: 'end' }}>
          {schoolWide && campuses.length > 1 && (
            <div>
              <label htmlFor="prm-campus">Campus</label>
              <select id="prm-campus" value={campusId} onChange={(e) => { setCampusId(e.target.value); setPreview(null); setChoices(new Map()); }}>
                {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="prm-year">Promote into</label>
            <select id="prm-year" value={targetYearId} onChange={(e) => { setTargetYearId(e.target.value); setPreview(null); }}>
              <option value="">{targets.length ? 'Choose next year' : 'Add next year first'}</option>
              {targets.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
            </select>
          </div>
          <div><button type="button" disabled={!campusId || !targetYearId || busy} onClick={runPreview}>{busy ? 'Building…' : preview ? 'Refresh list' : 'Review the list'}</button></div>
        </div>
        {targets.length === 0 && years.length > 0 && (
          <p className="field-hint" style={{ margin: 0 }}>Add next year under School configuration → School year, then come back.</p>
        )}
        {canOverride && preview?.requireFeeClearance !== undefined && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={overrideFees} style={{ width: 'auto' }} onChange={(e) => { setOverrideFees(e.target.checked); setStale(true); }} />
            Promote students who still owe fees (the balance stays on record)
          </label>
        )}
      </div>

      {err && <div className="toast err" role="alert">{err}</div>}
      {result && (
        <div className="toast ok stack" role="status" style={{ gap: 4 }}>
          <strong>Promotion done.</strong>
          <span>{result.promoted} promoted · {result.retained} retained · {result.completed} completed school · {result.withdrawn} leaving{result.blocked.length ? ` · ${result.blocked.length} not moved` : ''}.</span>
        </div>
      )}

      {preview && t && (
        <>
          <div className="card row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <span><strong>{t.promoted}</strong> <span className="muted">promote</span></span>
            <span><strong>{t.retained}</strong> <span className="muted">retain</span></span>
            <span><strong>{t.completed}</strong> <span className="muted">complete school</span></span>
            <span><strong>{t.withdrawn}</strong> <span className="muted">leaving</span></span>
            {t.skipped > 0 && <span><strong>{t.skipped}</strong> <span className="muted">already moved</span></span>}
            {t.blocked > 0 && <span className="badge bad">{t.blocked} need a decision</span>}
            <span style={{ flex: 1 }} />
            {stale && <span className="muted" style={{ fontSize: 13 }}>Choices changed — refresh the list first.</span>}
            <button type="button" disabled={stale || busy || t.promoted + t.retained + t.completed + t.withdrawn === 0} onClick={() => setConfirming(true)}>
              Promote into {preview.targetYear.name}
            </button>
          </div>

          {blocked.length > 0 && (
            <div className="card stack" style={{ gap: 6, borderLeft: '4px solid #b91c1c' }}>
              <strong>These students will not be moved</strong>
              {blocked.map((l) => (
                <div key={l.studentId} className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 14 }}>
                  <span>{l.studentName} <span className="muted">· {l.section}</span></span>
                  <span className="badge bad">{l.blocked}</span>
                  <ChoiceSelect value={choices.get(l.studentId) ?? 'PROMOTE'} onChange={(c) => choose(l.studentId, c)} />
                </div>
              ))}
            </div>
          )}

          {preview.sections.map((s) => (
            <details key={s.sectionId} className="card" open={preview.sections.length <= 3}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>{s.label}</strong> <span className="muted">· {s.lines.length} student{s.lines.length === 1 ? '' : 's'}</span>
              </summary>
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table>
                  <thead><tr><th>Student</th><th>Outcome</th><th>Next year</th><th>Choice</th></tr></thead>
                  <tbody>
                    {s.lines.map((l) => (
                      <tr key={l.studentId}>
                        <td>{l.studentName}</td>
                        <td>
                          {l.skipped ? <span className="muted">Already moved</span>
                            : l.blocked ? <span className="badge bad">{l.blocked}</span>
                            : <span className={`badge ${OUTCOME[l.outcome ?? '']?.tone ?? ''}`}>{OUTCOME[l.outcome ?? '']?.label}</span>}
                        </td>
                        <td>{l.toLabel ?? <span className="muted">—</span>}</td>
                        <td>{!l.skipped && <ChoiceSelect value={choices.get(l.studentId) ?? 'PROMOTE'} onChange={(c) => choose(l.studentId, c)} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>
      )}

      {confirming && preview && t && (
        <ReasonedActionDialog
          title={`Promote into ${preview.targetYear.name}?`}
          confirmLabel="Promote"
          destructive={false}
          reasonLabel="Note for the record"
          reasonPlaceholder="e.g. Year-end promotion approved by the principal"
          consequence={
            <>
              <strong>{t.promoted}</strong> promoted, <strong>{t.retained}</strong> retained, <strong>{t.completed}</strong> complete school,
              <strong> {t.withdrawn}</strong> leaving{t.blocked ? <>; <strong>{t.blocked}</strong> not moved</> : null}. All of it happens together
              or not at all. If anything changed since you reviewed the list, you will be asked to review it again.
            </>
          }
          onConfirm={async (reason) => {
            const res = await api.promotions.commit({ ...body(), fingerprint: preview.fingerprint, reason });
            setResult(res);
            setPreview(null);
            setChoices(new Map());
            return `${res.promoted} promoted, ${res.completed} completed school.`;
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function ChoiceSelect({ value, onChange }: { value: Choice; onChange: (c: Choice) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Choice)} style={{ minWidth: 130 }} aria-label="Choice for this student">
      <option value="PROMOTE">Promote</option>
      <option value="RETAIN">Retain</option>
      <option value="WITHDRAW">Leaving</option>
    </select>
  );
}
