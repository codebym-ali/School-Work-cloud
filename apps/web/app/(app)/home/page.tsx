'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type CheckInState, type CoverRow, type MyCover, type MyTimetable, type MyUnmarkedRegisters, type NotificationItem, type TimetableSlot } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { DAY_NAMES, sectionLabel, todayDow } from '@/lib/timetable';

/**
 * The teacher's home (Teacher Mobile Home Plan, M1).
 *
 * A teacher had no home at all — the post-login landing was `/attendance`, a work screen opened
 * cold with no idea which section was wanted. The organising idea is that the useful answer
 * **changes through the day**: at 07:50 it is "am I checked in", at 11:15 it is "which register am
 * I supposed to be marking", at 16:30 it is "what did I miss". So one card at the top answers
 * whichever of those it currently is, and everything else stays quiet beneath it.
 *
 * **The register button is the point of the screen.** Marking attendance today is: open Attendance
 * → pick class → pick section → find the date, on a phone, mid-lesson. The timetable already knows
 * which section this teacher is standing in front of, so the home hands them that register in one
 * tap. Everything else here is context for that one action.
 *
 * No new endpoints — `/timetable/mine`, `/notifications` and the check-in state already exist.
 *
 * **Cover outranks the timetable in the now card** (Cover Plan C2). Your own periods you already
 * know; a class you have been handed this morning is the thing you do not. It also has to work
 * where the timetable does not exist at all — every school has zero slots today — so cover is read
 * from its own endpoint rather than inferred from a grid that may be empty.
 */
export default function TeacherHome() {
  const me = useMe();
  const [timetable, setTimetable] = useState<MyTimetable | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [checkIn, setCheckIn] = useState<CheckInState | null>(null);
  const [cover, setCover] = useState<MyCover | null>(null);
  const [unmarkedMine, setUnmarkedMine] = useState<MyUnmarkedRegisters | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    // Each fails silently and independently: a home screen that goes blank because one of three
    // rollups was denied is worse than a home screen missing one card.
    api.timetable.mine().then(setTimetable).catch(() => setTimetable({ as: 'NONE', academicYearId: '', slots: [] }));
    api.notifications.list().then((r) => setItems(r.items)).catch(() => {});
    api.staff.checkInState().then(setCheckIn).catch(() => {});
    api.cover.mine().then(setCover).catch(() => {});
    api.staff.myUnmarkedRegisters().then(setUnmarkedMine).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const dow = todayDow();
  const today = (timetable?.slots ?? []).filter((s) => s.dayOfWeek === dow).sort((a, b) => a.periodNo - b.periodNo);

  // "Now" is the first period today whose register is still unmarked — the system cannot know
  // which bell is ringing (there are no period times in the model), so it uses the honest proxy:
  // the earliest thing still outstanding. Comment kept because "now" implies a clock that is not
  // there, and the next reader will otherwise go looking for one.
  const covering = cover?.covering ?? [];
  const now: TimetableSlot | undefined = today[0];
  // A cover takes the top card ahead of an ordinary period: it is today's exception, and it is the
  // one thing on this screen the teacher had no other way of finding out.
  const coverNow: CoverRow | undefined = covering[0];
  const rest = today.slice(1);

  /**
   * ⚠️ **Deliberately NOT gated on `due`, unlike the bell.** The mark-by deadline exists to stop a
   * *warning* firing during the lesson it is about. This card is not a warning — it is the answer
   * to "what am I doing now", and at 08:30 that answer is still "mark 9-A". Gating it here also
   * produced a lie: with the list emptied before the deadline, the screen fell through to the
   * good-news branch and claimed every register was marked.
   */
  const myUnmarked = unmarkedMine?.sections ?? [];
  const [firstUnmarked, ...restUnmarked] = myUnmarked;
  /**
   * ⚠️ **`responsible`, not `sections.length`.** `sections` holds only the UNMARKED ones, so once
   * the teacher finishes it is empty — which made the "all done" branch unreachable and sent a
   * teacher who had just marked everything to "No timetable has been set for you yet". Caught in a
   * browser, not by a test: both branches type-check and both render.
   */
  const responsible = unmarkedMine?.responsible ?? 0;
  // The register reminder is filtered out of "Needs you" because the card above says the same
  // thing better — it names the class and links straight to it. Two versions of one message on one
  // screen is how a list of alerts stops being read.
  const needsYou = items.filter((i) => i.kind !== 'REGISTER_UNMARKED');
  const firstName = (me?.email ?? '').split('@')[0].split('.')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  async function doCheckIn() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.staff.checkIn();
      setMsg(res.status === 'LATE' ? 'Checked in — recorded as late.' : 'Checked in.');
      await load();
    } catch {
      setMsg('Could not check you in. Try again, or ask the office.');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div>
        {/* `capitalize` on the whole heading title-cased the greeting into "Good Morning" — it
            belongs on the name alone, which arrives lowercased from the email local-part. */}
        <h1 style={{ marginBottom: 2 }}>{greeting}, <span style={{ textTransform: 'capitalize' }}>{firstName}</span></h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {DAY_NAMES[dow]}, {new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
        </p>
      </div>

      {msg && <div className="toast ok">{msg}</div>}

      {/* Check-in comes first only while it is still outstanding — once you are in, it is noise. */}
      {checkIn?.enabled && !checkIn.nonWorkingDay && !checkIn.today && (
        <div className="card row" style={{ gap: 12 }}>
          <div>
            <strong style={{ fontSize: 15 }}>You haven&apos;t checked in</strong>
            {/* The clock decides, so say which answer it will give before the button is pressed —
                being marked late by surprise is what makes people distrust the register. */}
            <div className="muted" style={{ fontSize: 13 }}>
              {checkIn.wouldBe === 'LATE' ? 'Checking in now records you as late.' : 'You are on time.'}
            </div>
          </div>
          <button onClick={doCheckIn} disabled={busy} style={{ minHeight: 44 }}>
            {busy ? 'Checking in…' : 'Check in'}
          </button>
        </div>
      )}

      {/* ── The one loud thing on the page ── */}
      {coverNow ? (
        <div className="now">
          <p className="eyebrow">Covering{coverNow.periodNo ? ` · Period ${coverNow.periodNo}` : ' · all day'}</p>
          <p className="headline">{coverNow.section.class.name}-{coverNow.section.name}</p>
          <p className="detail">
            {coverNow.absentStaff
              ? `For ${coverNow.absentStaff.fullName ?? coverNow.absentStaff.employeeCode}`
              : 'Arranged by the office'}
            {coverNow.reason ? ` · ${coverNow.reason}` : ''}
          </p>
          {/* This button is the whole feature: before C0 it returned "You are not assigned to this
              section", and the grant is what makes it work. */}
          <Link className="cta" href={`/attendance?sectionId=${coverNow.section.id}`}>Mark this register</Link>
        </div>
      ) : now ? (
        <div className="now">
          <p className="eyebrow">Now · Period {now.periodNo}</p>
          <p className="headline">{sectionLabel(now)}</p>
          <p className="detail">{now.subject.name}{now.room ? ` · ${now.room}` : ''}</p>
          <Link className="cta" href={`/attendance?sectionId=${now.section.id}`}>Mark this register</Link>
        </div>
      ) : firstUnmarked ? (
        /* No timetable, but a register with this teacher's name on it (T2).
         *
         * ⚠️ This card used to read "A register needs marking" over "No timetable has been set for
         * you yet" with a generic *Open attendance* — a headline promising a task, a body
         * withdrawing it, and a button that opened a screen cold. **The system knew which register
         * the whole time**; the count was computed and the names thrown away. Since every school
         * has zero timetable rows today, this is the card most teachers actually see, so it is the
         * one that has to do the work. */
        <div className="now">
          <p className="eyebrow">Today</p>
          <p className="headline">Mark {firstUnmarked.className}-{firstUnmarked.sectionName}</p>
          <p className="detail">
            {firstUnmarked.marked > 0
              // Half-done and never-started are different problems needing different effort, and
              // the register screen already makes that distinction.
              ? `${firstUnmarked.marked} of ${firstUnmarked.expected} marked so far`
              : `${firstUnmarked.expected} student${firstUnmarked.expected === 1 ? '' : 's'}`}
            {restUnmarked.length > 0 && ` · ${restUnmarked.length} more register${restUnmarked.length === 1 ? '' : 's'} after this`}
          </p>
          <Link className="cta" href={`/attendance?sectionId=${firstUnmarked.sectionId}`}>Mark this register</Link>
        </div>
      ) : (
        /* Degrading honestly matters more here than anywhere: the timetable feature shipped on
           2026-08-08 with zero rows in every school, so for most schools this is what the home
           looks like on day one. It must explain itself rather than sit empty. */
        <div className="now">
          <p className="eyebrow">Today</p>
          <p className="headline">{responsible > 0 ? 'Nothing to mark' : 'Nothing scheduled'}</p>
          <p className="detail">
            {responsible > 0
              // Said plainly rather than left blank: "no periods today" on a screen with no
              // timetable reads as a fault, when the truth is that the work is done.
              ? 'Every register you are responsible for is marked.'
              : timetable?.slots.length
                ? 'You have no periods today.'
                : 'No timetable has been set for you yet — the office builds it under Timetable.'}
          </p>
          <Link className="cta" href="/attendance">Open attendance</Link>
        </div>
      )}

      {(rest.length > 0 || covering.length > 1 || (coverNow && today.length > 0)) && (
        <div className="card">
          <div className="section-title">Later today</div>
          <ul className="day-rail">
            {/* Whichever cover did not get the top card, plus — when a cover DID take it — the
                teacher's own periods, which would otherwise have vanished off the screen. */}
            {covering.slice(coverNow ? 1 : 0).map((c) => (
              <li key={c.id}>
                <span className="p">{c.periodNo ? `P${c.periodNo}` : 'Cvr'}</span>
                <span>
                  <span className="what">{c.section.class.name}-{c.section.name} · Covering</span>
                  {c.absentStaff && <><br /><span className="where">for {c.absentStaff.fullName ?? c.absentStaff.employeeCode}</span></>}
                </span>
              </li>
            ))}
            {(coverNow ? today : rest).map((s) => (
              <li key={s.id}>
                <span className="p">P{s.periodNo}</span>
                <span>
                  <span className="what">{sectionLabel(s)} · {s.subject.name}</span>
                  {s.room && <><br /><span className="where">{s.room}</span></>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsYou.length > 0 && (
        <div className="card">
          <div className="section-title">Needs you</div>
          <ul className="day-rail">
            {needsYou.map((n) => (
              <li key={n.id} style={{ gridTemplateColumns: '20px 1fr' }}>
                <span aria-hidden="true">{n.severity === 'warn' ? '⚠️' : '✓'}</span>
                <Link href={n.href} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <span className="what">{n.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
