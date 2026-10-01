'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, isProposal, PAYMENT_METHODS, PAYMENT_METHOD_LABEL, type SchoolSettings, type WeekDay } from '@sw/api-client';
import { useMe } from '@sw/session';
import { isSchoolWideAdmin } from '@sw/roles';

const DAYS: WeekDay[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const short = (d: WeekDay) => d.slice(0, 3);

/**
 * The school's own operating rules.
 *
 * These could previously only be changed by a developer writing to the database, so a school
 * could not set its own working week or fee due day without filing a request — and a teacher
 * checking in at 19:18 was marked late against an 08:00 default nobody could see.
 *
 * Each field states **what it does**, not what it is called. "attendanceBackfillDays: 7" is a
 * variable name; "a teacher may fill in a missed day up to 7 days later" is the rule the
 * office actually operates. Every change saves on its own so nothing is lost by leaving.
 */
export default function SettingsPage() {
  const me = useMe();
  const canEdit = isSchoolWideAdmin(me?.roles);
  // Whether fees are shown to campus admins is the OWNER's call — not the Ops Admin's.
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [s, setS] = useState<SchoolSettings | null>(null);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => { api.schoolSettings.get().then(setS).catch(() => setErr(true)); }, []);

  async function save(key: string, patch: Parameters<typeof api.schoolSettings.update>[0]) {
    setBusy(key);
    setMsg(null);
    try {
      const res = await api.schoolSettings.update(patch);
      if (isProposal(res)) {
        // An Ops Admin's change is only a proposal: show what is actually stored, and say where it went.
        setMsg({ ok: true, text: 'Sent to the owner for approval — it takes effect once approved.' });
        api.schoolSettings.get().then(setS).catch(() => {});
        return;
      }
      setS(res);
      setMsg({ ok: true, text: 'Saved' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save that.' });
      // Re-read so the form shows what is actually stored, not the value that was rejected.
      api.schoolSettings.get().then(setS).catch(() => {});
    } finally {
      setBusy('');
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your school settings.</p>;
  if (!s) return <p className="muted">Loading…</p>;

  const attendance = s.staffAttendance;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>School settings</h1>
        <p className="muted" style={{ margin: 0 }}>
          The rules your school runs on. Changes take effect immediately — nobody needs to sign in again.
        </p>
      </div>

      {!canEdit && (
        <div className="toast warn">
          These are set by the school owner or an operations admin. You can see the rules you work under, but not change them.
        </div>
      )}
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <Section title="Where the school is" blurb="The clock every timing rule is judged against — lateness, the staff day close, and when a class register counts as overdue.">
        <div style={{ maxWidth: 260 }}>
          <label>Time zone</label>
          <select aria-label="Time zone" value={s.timezone} disabled={!canEdit || busy === 'timezone'}
            onChange={(e) => save('timezone', { timezone: e.target.value })}>
            {/* A short, honest list rather than all ~600 IANA zones: this product serves Pakistani
                schools, and a 600-item dropdown is a worse answer than five relevant ones. The API
                accepts any valid IANA name, so an unusual one is a settings call away. */}
            {[...new Set(['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Europe/London', 'UTC', s.timezone])].map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>
        <Hint>
          Every rule that asks &ldquo;what time is it?&rdquo; uses this — not the server&apos;s clock.
          Dates on records are unaffected.
        </Hint>
      </Section>

      <Section title="The working week" blurb="Which days the school is closed. Attendance is not taken on these days, and they are excluded from attendance percentages.">
        <div className="chips">
          {DAYS.map((d) => {
            const on = s.weeklyOffDays.includes(d);
            return (
              <button key={d} type="button" className={`chip${on ? ' active' : ''}`}
                disabled={!canEdit || busy === 'weeklyOffDays'}
                onClick={() => save('weeklyOffDays', {
                  weeklyOffDays: on ? s.weeklyOffDays.filter((x) => x !== d) : [...s.weeklyOffDays, d],
                })}>
                {short(d)}
              </button>
            );
          })}
        </div>
        <Hint>
          {s.weeklyOffDays.length === 0
            ? '⚠️ No days off — attendance will be expected seven days a week.'
            : `Closed on ${s.weeklyOffDays.map(short).join(', ')}.`}
        </Hint>
        {/* The other half of "when is this school open". This one is a recurring rule; individual
            closures are dated records and live on their own screen. */}
        <Hint>
          Eid, public holidays and one-off closures are dated records —{' '}
          <a href="/calendar">School calendar</a>.
        </Hint>
      </Section>

      <Section title="Staff attendance" blurb="How your teachers' own attendance is recorded. These feed the payroll attendance deduction, so they are owner-only.">
        <Toggle label="Let staff check themselves in"
          hint="A teacher marks only that they are present, only for today. They can never record their own absence, and the system decides on time vs late from the clock."
          checked={attendance.selfMarking} disabled={!canEdit || busy === 'staffAttendance'}
          onChange={(v) => save('staffAttendance', { staffAttendance: { selfMarking: v } })} />

        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          <div style={{ maxWidth: 160 }}>
            <label>The school day starts at</label>
            <input type="time" defaultValue={attendance.dayStartTime} disabled={!canEdit}
              onBlur={(e) => { if (e.target.value && e.target.value !== attendance.dayStartTime) save('staffAttendance', { staffAttendance: { dayStartTime: e.target.value } }); }} />
          </div>
          <div style={{ maxWidth: 190 }}>
            <label>Still on time for (minutes)</label>
            <input type="number" min={0} max={120} defaultValue={attendance.graceMinutes} disabled={!canEdit}
              onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== attendance.graceMinutes) save('staffAttendance', { staffAttendance: { graceMinutes: n } }); }} />
          </div>
        </div>
        {/* State the consequence in the school's own terms — this is the setting that made a
            19:18 check-in read as "late" with nothing on screen to explain why. */}
        <Hint>
          Anyone checking in after <strong>{addMinutes(attendance.dayStartTime, attendance.graceMinutes)}</strong> is marked late.
        </Hint>

        <Toggle label="Mark everyone unmarked as absent at the end of each day"
          checked={attendance.autoMarkAbsent} disabled={!canEdit || busy === 'staffAttendance'}
          onChange={(v) => save('staffAttendance', { staffAttendance: { autoMarkAbsent: v } })}
          hint="Approved leave is recorded as leave, holidays are skipped, and anything already recorded is left alone." />
        {/* This is the one switch that creates salary deductions with nobody pressing anything,
            so the consequence is stated where the decision is made — not discovered on a payslip. */}
        <Hint>
          {attendance.autoMarkAbsent
            ? '⚠️ Absences reduce pay. Anyone the office forgets to mark will be recorded absent for that day.'
            : 'Off: a day nobody records stays “not marked”, and the register shows it as a gap to chase.'}
        </Hint>

        {/* Only offered when the close actually runs — a time that governs nothing is a decision
            the reader has to make for no reason. Same rule that kept `autoMarkAbsent` off this
            screen while the job was unbuilt. */}
        {attendance.autoMarkAbsent && (
          <>
            <div style={{ maxWidth: 160 }}>
              <label>Close the register at</label>
              <input type="time" defaultValue={attendance.closeAtTime} disabled={!canEdit}
                onBlur={(e) => { if (e.target.value && e.target.value !== attendance.closeAtTime) save('staffAttendance', { staffAttendance: { closeAtTime: e.target.value } }); }} />
            </div>
            {/* Was 20:00 for every school on the platform, in the server's timezone — so a school
                whose day ends at 13:00 waited seven hours, and a teacher arriving after the close
                found the button refusing them because a machine had already marked them absent. */}
            <Hint>
              At <strong>{attendance.closeAtTime}</strong> the day is settled: anyone still unmarked is
              recorded absent, and staff can no longer check themselves in for that day.
            </Hint>
          </>
        )}
      </Section>

      <Section title="Payroll" blurb="How attendance turns into money. Owner-only, because it decides what people are paid.">
        <Toggle label="Deduct pay for an unexplained absence"
          checked={s.payrollDeductsAbsence} disabled={!canEdit || busy === 'payrollDeductsAbsence'}
          onChange={(v) => save('payrollDeductsAbsence', { payrollDeductsAbsence: v })}
          hint="A day marked ABSENT costs one day of basic pay (basic ÷ working days in the month). Allowances are never docked." />
        {/* The distinction people get wrong: this governs ABSENCE, not unpaid leave. Approved
            unpaid leave is deducted either way — unpaid leave that does not reduce pay is a
            contradiction with a label. State it here rather than let a payslip raise it. */}
        <Hint>
          {s.payrollDeductsAbsence
            ? '⚠️ Absences reduce pay. Approved unpaid leave is deducted as well — that is what "unpaid" means.'
            : 'Off: absences are recorded in the register but never touch salary. Approved UNPAID leave is still deducted.'}
        </Hint>
        {/* Payroll stores its figures when the run is generated, so a change now cannot move a
            payslip that already exists. Said plainly, because "I changed the setting and nothing
            happened" is otherwise a support call. */}
        <Hint>
          Applies to payroll generated from now on. A run already generated keeps the figures it
          was computed with, and an approved run never changes.
        </Hint>
      </Section>

      <Section title="Fees and the campus admin" blurb="Whether your campus admins (principals) can see the school's fee information. Only you, the owner, can change this.">
        <Toggle label="Let campus admins see fees"
          checked={s.campusAdminSeesFees} disabled={!isOwner || busy === 'campusAdminSeesFees'}
          onChange={(v) => save('campusAdminSeesFees', { campusAdminSeesFees: v })}
          hint="Covers a child's fee status and fee history, the defaulters list, payment submissions, the fee reports and the money figures on the dashboard. A campus admin can only ever look — recording payments stays with the accountant and Ops Admin." />
        <Hint>
          {s.campusAdminSeesFees
            ? 'On: a campus admin can see fee information for their own campus (read-only).'
            : 'Off: fees are hidden from campus admins everywhere. Your accountant, Ops Admin and you are unaffected.'}
        </Hint>
        <Toggle label="I approve each campus's monthly fee vouchers before they go out"
          checked={s.feeVoucherApproval} disabled={!isOwner || busy === 'feeVoucherApproval'}
          onChange={(v) => save('feeVoucherApproval', { feeVoucherApproval: v })}
          hint="When the Ops Admin or accountant generates a month's vouchers, they wait on your Approvals page. Families see nothing, and nothing can be paid against them, until you approve." />
        <Hint>
          {s.feeVoucherApproval
            ? 'On: office-generated vouchers are held for you. Vouchers you generate yourself, and single-student invoices at the counter, are never held.'
            : 'Off: vouchers go out as soon as the office generates them.'}
        </Hint>
      </Section>

      <Section title="Student attendance" blurb="When registers are expected, and how far back one may be filled in or corrected.">
        <div style={{ maxWidth: 160 }}>
          <label>Registers marked by</label>
          <input type="time" defaultValue={s.attendanceMarkByTime} disabled={!canEdit}
            onBlur={(e) => { if (e.target.value && e.target.value !== s.attendanceMarkByTime) save('attendanceMarkByTime', { attendanceMarkByTime: e.target.value }); }} />
        </div>
        {/* Says plainly what it does and — just as importantly — what it does NOT do. A setting
            that looks like enforcement but only changes a dashboard would be worse than none. */}
        <Hint>
          After <strong>{s.attendanceMarkByTime}</strong> your dashboard lists any section whose register
          is still unmarked. Nothing is blocked and nobody is marked automatically — an unmarked day
          stays a gap until a person fills it in.
        </Hint>
        <NumberRow label="A teacher may fill in a missed day up to" suffix="days later"
          value={s.attendanceBackfillDays} min={0} max={90} disabled={!canEdit}
          onSave={(v) => save('attendanceBackfillDays', { attendanceBackfillDays: v })}
          hint="Admins are never limited. Set 0 to allow marking today only." />
        <NumberRow label="A mark can be corrected for" suffix="days"
          value={s.attendanceEditWindowDays} min={0} max={90} disabled={!canEdit}
          onSave={(v) => save('attendanceEditWindowDays', { attendanceEditWindowDays: v })}
          hint="After this, only an admin can change it — and the change is recorded." />
      </Section>

      <Section title="Fees" blurb="Defaults applied when invoices are generated.">
        <NumberRow label="Fees are due on day" suffix="of the month"
          value={s.feeDueDay} min={1} max={28} disabled={!canEdit}
          onSave={(v) => save('feeDueDay', { feeDueDay: v })}
          hint="Capped at 28 so every month has that day." />
        <NumberRow label="Sibling discount" suffix="%"
          value={s.siblingDiscountPercent} min={0} max={100} disabled={!canEdit}
          onSave={(v) => save('siblingDiscountPercent', { siblingDiscountPercent: v })} />
        <Toggle label="A student must clear their fees before being promoted"
          checked={s.promotionRequiresFeeClearance} disabled={!canEdit || busy === 'promotionRequiresFeeClearance'}
          onChange={(v) => save('promotionRequiresFeeClearance', { promotionRequiresFeeClearance: v })}
          hint="An admin can still override for one student, and the override is recorded." />
      </Section>

      <Section title="Fee collection" blurb="How your school takes money, and what the office must attach when it does.">
        <div className="stack" style={{ gap: 4 }}>
          <span style={{ fontSize: 14 }}>We accept</span>
          <div className="chips">
            {PAYMENT_METHODS.map((m) => {
              const on = s.feeSubmission.methods.includes(m);
              // Never let the last one be switched off — a school that accepts nothing cannot
              // take a payment at all, and the API would refuse every method.
              const last = on && s.feeSubmission.methods.length === 1;
              return (
                <button key={m} type="button" className={`chip${on ? ' active' : ''}`}
                  disabled={!canEdit || last || busy === 'feeSubmission'}
                  title={last ? 'Your school must accept at least one way of paying' : undefined}
                  onClick={() => save('feeSubmission', {
                    feeSubmission: {
                      methods: on ? s.feeSubmission.methods.filter((x) => x !== m) : [...s.feeSubmission.methods, m],
                    },
                  })}>
                  {on ? '✓ ' : ''}{PAYMENT_METHOD_LABEL[m]}
                </button>
              );
            })}
          </div>
          <Hint>
            Only these appear when the office collects a payment — and anything else is refused,
            not just hidden.
          </Hint>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <span style={{ fontSize: 14 }}>Proof of payment for non-cash</span>
          <Choice
            value={s.feeSubmission.proofPolicy} disabled={!canEdit || busy === 'feeSubmission'}
            onChange={(v) => save('feeSubmission', { feeSubmission: { proofPolicy: v as SchoolSettings['feeSubmission']['proofPolicy'] } })}
            options={[
              { value: 'OFF', label: 'Don’t ask for it', hint: 'Only the reference number is recorded.' },
              { value: 'OPTIONAL', label: 'Attach it when there is one', hint: 'The screenshot or stamped challan is kept with the payment.' },
              { value: 'REQUIRED', label: 'Always require it', hint: 'A bank transfer or wallet payment cannot be recorded without the proof.' },
            ]} />
        </div>

        {s.feeSubmission.methods.includes('CHEQUE') && (
          <NumberRow label="A cheque counts as paid after" suffix="days"
            value={s.feeSubmission.chequeClearingDays} min={0} max={30} disabled={!canEdit}
            onSave={(v) => save('feeSubmission', { feeSubmission: { chequeClearingDays: v } })}
            hint="A cheque is not money until it clears — this is how long it is held first." />
        )}

        <Toggle label="Let parents send proof from a link in the fee SMS"
          checked={s.feeSubmission.guardianUploadLink} disabled={!canEdit || busy === 'feeSubmission'}
          onChange={(v) => save('feeSubmission', { feeSubmission: { guardianUploadLink: v } })}
          hint="No account needed — the fee SMS carries a private link where a parent can upload their transfer screenshot. The office still verifies every one before a receipt is issued." />
      </Section>

      <Section title="Admissions" blurb="How students are taken on.">
        <Choice
          value={s.admissionsMode} disabled={!canEdit || busy === 'admissionsMode'}
          onChange={(v) => save('admissionsMode', { admissionsMode: v as SchoolSettings['admissionsMode'] })}
          options={[
            { value: 'DIRECT', label: 'Fill the form and admit', hint: 'No enquiry register, no entry tests. Most schools work this way.' },
            { value: 'PIPELINE', label: 'Track enquiries and entry tests', hint: 'Adds the enquiry pipeline and its conversion reporting.' },
          ]} />
      </Section>

      <Section title="Sections" blurb="What happens when a section is full.">
        <Choice
          value={s.sectionCapacityMode} disabled={!canEdit || busy === 'sectionCapacityMode'}
          onChange={(v) => save('sectionCapacityMode', { sectionCapacityMode: v as SchoolSettings['sectionCapacityMode'] })}
          options={[
            { value: 'ADVISORY', label: 'Warn, but allow', hint: 'The seat count goes red; admission still goes through.' },
            { value: 'HARD', label: 'Refuse the admission', hint: 'Nobody can be admitted into a full section.' },
          ]} />
      </Section>
    </div>
  );
}

const addMinutes = (hhmm: string, mins: number) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="stack" style={{ gap: 2 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{blurb}</p>
      </div>
      {children}
    </div>
  );
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="muted" style={{ margin: 0, fontSize: 12 }}>{children}</p>
);

function Toggle({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

/** Saves on blur, not on every keystroke — otherwise "15" is written as 1 then 15. */
function NumberRow({ label, suffix, value, min, max, disabled, hint, onSave }: {
  label: string; suffix?: string; value: number; min: number; max: number;
  disabled?: boolean; hint?: string; onSave: (v: number) => void;
}) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14 }}>{label}</span>
        <input type="number" min={min} max={max} defaultValue={value} disabled={disabled}
          style={{ maxWidth: 90 }}
          onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== value) onSave(n); }} />
        {suffix && <span style={{ fontSize: 14 }}>{suffix}</span>}
      </div>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

function Choice({ value, options, disabled, onChange }: {
  value: string; disabled?: boolean;
  options: { value: string; label: string; hint: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
          <input type="radio" style={{ width: 'auto', marginTop: 3 }} checked={value === o.value} disabled={disabled}
            onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>{o.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
