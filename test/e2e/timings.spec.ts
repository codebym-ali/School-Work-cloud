import { test, expect } from '@playwright/test';
import { gotoApp, apiSetupGet, apiSetupPost, apiSetupPut, apiSetupDelete, e2eCampusId } from './helpers';

/**
 * School timings, and the grid that renders them.
 *
 * ⚠️ **The timetable has never had a browser test.** It shipped with 19 integration cases and no
 * Playwright coverage at all — the only major screen in the product without any — which is exactly
 * the gap that let a stale `attendance.spec` sit red for two milestones and a `/home` route stay
 * orphaned on desktop for four phases. Nothing failed, because nothing looked.
 *
 * The load-bearing assertions are the two things no integration test can see:
 *   1. the times the *screen* computes as you type durations match the ones the SERVER stores;
 *   2. a short Friday renders as short — its missing periods are absent cells, not empty ones.
 *
 * Owns its own campus-scoped schedule and removes it, so it can be run twice in a row without the
 * second run reading the first one's leftovers — the reusable-fixture rule this suite learned the
 * hard way when the demo tenant filled with 185 `Cls<timestamp>` classes.
 */
test.describe('school timings', () => {
  const NAME = 'E2E Timings';

  /**
   * ⚠️ Everything this spec creates, so `afterEach` can take it back out.
   *
   * The first version of this file cleaned up only its bell schedules and left a
   * `TmCls<timestamp>` class behind on every run — **while its own doc comment cited the 185
   * leftover classes as the reason to know better.** These specs run against the operator's real
   * demo tenant, so debris lands in a screen a human actually looks at; it was spotted at the top
   * of the Classes page. Creating is not the hard part of a fixture — giving it back is.
   */
  const created: { classes: string[]; sections: string[] } = { classes: [], sections: [] };

  const mkClass = async (page: import('@playwright/test').Page, campusId: string) => {
    const k = await apiSetupPost<{ id: string }>(page, '/classes', {
      campusId, name: `TmCls${Date.now()}`, order: 1,
    });
    created.classes.push(k.id);
    return k;
  };
  const mkSection = async (page: import('@playwright/test').Page, classId: string) => {
    const sec = await apiSetupPost<{ id: string }>(page, '/sections', { classId, name: 'A' });
    created.sections.push(sec.id);
    return sec;
  };

  /** The composed day the whole spec is written around: assembly, two periods, break, two periods. */
  const MONDAY = [
    { label: 'Assembly', minutes: 15, teaching: false },
    { minutes: 40, teaching: true },
    { minutes: 40, teaching: true },
    { label: 'Break', minutes: 15, teaching: false },
    { minutes: 40, teaching: true },
    { minutes: 40, teaching: true },
  ];

  /**
   * ⚠️ **Best-effort must still be LOUD.** These `catch`es used to be `/* ignore *\/`, and they hid a
   * real leak for months: `DELETE /classes/:id` was failing on every run — a soft-deleted bell
   * schedule left a RESTRICT foreign key behind — so the demo tenant reached **18 leftover
   * `TmCls…` classes out of 28**, which is what finally made `timings` fail as the grid filled with
   * debris. Silence is what let a broken cleanup look like a working one.
   *
   * A warning, not a throw: cleanup must never be the loudest thing in a failing test, but it must
   * not be inaudible either.
   */
  /**
   * Choose an option and make it STICK.
   *
   * WARNING: **`selectOption` alone is a race against the page's own data load.** It resolves as
   * soon as it has set a value, but `/timings` and `/timetable` both fetch their options after the
   * first paint and re-render when the answer arrives — which silently resets the select. Alone on
   * an idle machine the fetch had usually landed first, so this passed; in a full suite run it lost
   * the race and the test then failed further down as a *content* mismatch, reading like a product
   * bug in the timetable rather than a selection that never happened.
   *
   * `toPass` retries the set-and-verify pair, so it converges once the page settles instead of
   * depending on which finished first.
   */
  const selectWhenReady = async (page: import('@playwright/test').Page, selector: string, value: string) => {
    await expect(async () => {
      await page.selectOption(selector, value);
      await expect(page.locator(selector)).toHaveValue(value);
    }).toPass({ timeout: 15_000 });
  };

  const warnLeak = (kind: string, id: string) =>
    // eslint-disable-next-line no-console
    console.warn(`[timings cleanup] LEAKED ${kind} ${id} — it will accumulate in the demo tenant.`);

  test.afterEach(async ({ page }) => {
    // Best-effort: cleanup must never be the loudest thing in a failure. Order matters — a
    // schedule references its classes, and a class will not delete while it has sections.
    try {
      const res = await apiSetupGet<{ schedules: Array<{ id: string; name: string }> }>(page, '/bell-schedules');
      for (const s of res.schedules.filter((x) => x.name === NAME)) {
        await apiSetupDelete(page, `/bell-schedules/${s.id}`);
      }
    } catch { /* ignore */ }
    for (const id of created.sections.splice(0)) {
      try { await apiSetupDelete(page, `/sections/${id}`); } catch { warnLeak('section', id); }
    }
    for (const id of created.classes.splice(0)) {
      try { await apiSetupDelete(page, `/classes/${id}`); } catch { warnLeak('class', id); }
    }
  });

  test('the day is composed from durations, and the screen agrees with the server', async ({ page }) => {
    await gotoApp(page);
    const campusId = await e2eCampusId(page);
    // Seeded through the API so the test is about composing a day, not about creating a schedule.
    // It is NOT the campus default — the E2E campus may already have one, and taking that seat
    // would make this spec's success depend on whether it had run before.
    const klass = await mkClass(page, campusId);
    const schedule = await apiSetupPost<{ id: string }>(page, '/bell-schedules', {
      campusId, name: NAME, classIds: [klass.id],
    });

    await page.goto('/timings');
    /**
     * WARNING: **The picker must take before anything is typed into the page.** If the options have
     * not loaded, the screen is still showing a DIFFERENT schedule - and the "+ Add period" clicks
     * below then append rows to the school's REAL schedule instead of this spec's throwaway one.
     * That is how the day under test ended up with twelve rows: not a fixture leak, but this spec
     * quietly editing somebody else's timings.
     */
    await selectWhenReady(page, '#tm-schedule', schedule.id);

    /**
     * WARNING: **Each click must be seen to land before the next is sent.** Firing six clicks in a
     * row races the re-render they each trigger, so one can be swallowed — and the day then composes
     * to the wrong total, failing later on the preview assertion as though the arithmetic were
     * wrong. Waiting for row `i + 1` to exist makes the sequence deterministic instead of hopeful.
     *
     * ⚠️ **This is deliberately still driven through the UI.** Seeding the day through the API would
     * make this spec stable and pointless: the preview duplicates `composeBellDay` (the browser
     * cannot import `libs/common`), so typing the durations IS the test — it is the only thing
     * checking that the duplicate still agrees with the original. The Friday test below seeds via
     * the API precisely because it asserts RENDERING, not composition.
     */
    for (let i = 0; i < MONDAY.length; i++) {
      await page.getByRole('button', { name: MONDAY[i].teaching ? '+ Add period' : '+ Add break' }).click();
      await expect(page.getByLabel(`Minutes, row ${i + 1}`, { exact: true })).toBeVisible();
    }
    for (let i = 0; i < MONDAY.length; i++) {
      /**
       * WARNING: **`exact: true` is load-bearing - `getByLabel` matches a SUBSTRING by default.**
       * "Minutes, row 1" also matches "Minutes, row 10", "row 11", "row 12", so the moment a day has
       * ten or more rows this line dies with a strict-mode violation naming four elements. It passed
       * for months only because the day under test happened to be short: a locator that is correct
       * for six rows and wrong for ten is not a passing test, it is an unexploded one.
       */
      const minutes = page.getByLabel(`Minutes, row ${i + 1}`, { exact: true });
      await minutes.fill(String(MONDAY[i].minutes));
      // A `fill` that lands mid-re-render is discarded silently, and the only symptom is a wrong
      // total three assertions later. Read it back so the failure names the row that did not take.
      await expect(minutes).toHaveValue(String(MONDAY[i].minutes));
      if (!MONDAY[i].teaching) {
        const label = page.getByLabel(`Break name, row ${i + 1}`, { exact: true });
        await label.fill(MONDAY[i].label!);
        await expect(label).toHaveValue(MONDAY[i].label!);
      }
    }

    // What the SCREEN computed, before saving anything.
    const previewed = await page.locator('tbody tr td:first-child').allInnerTexts();
    await expect(page.getByText('Day ends 11:10')).toBeVisible();

    await page.getByRole('button', { name: 'Save Monday' }).click();
    await expect(page.locator('.toast.ok')).toContainText('Monday saved');

    // ⚠️ The assertion the whole "client sends durations" design rests on. The preview duplicates
    // `composeBellDay` because `libs/common` cannot be imported into `apps/web`, so the one thing
    // that must be true is that the duplicate agrees with the original. Reload first, so what is
    // compared is genuinely the STORED day and not the state still sitting in React.
    await page.reload();
    // Same reason as above: comparing against the wrong schedule's day would "prove" the screen and
    // the server disagree when in fact the test was reading someone else's timings.
    await selectWhenReady(page, '#tm-schedule', schedule.id);
    const stored = await page.locator('tbody tr td:first-child').allInnerTexts();
    expect(stored).toEqual(previewed);
    expect(stored[0]).toContain('08:00');
    expect(stored[5]).toContain('11:10');

    await expect(page.getByRole('button', { name: /^Mon · 4$/ })).toBeVisible();
  });

  test('a short Friday renders short — the grid shows absent periods, not empty ones', async ({ page }) => {
    await gotoApp(page);
    const campusId = await e2eCampusId(page);
    const klass = await mkClass(page, campusId);
    const section = await mkSection(page, klass.id);
    const schedule = await apiSetupPost<{ id: string }>(page, '/bell-schedules', {
      campusId, name: NAME, classIds: [klass.id],
    });
    await apiSetupPut(page, `/bell-schedules/${schedule.id}/days/1`, {
      startsAt: '08:00',
      rows: [{ isTeaching: true, minutes: 40 }, { isTeaching: true, minutes: 40 },
             { isTeaching: true, minutes: 40 }, { isTeaching: true, minutes: 40 }],
    });
    await apiSetupPut(page, `/bell-schedules/${schedule.id}/days/5`, {
      startsAt: '08:00',
      rows: [{ isTeaching: true, minutes: 35 }, { isTeaching: true, minutes: 35 }],
    });

    await page.goto('/timetable');
    /**
     * WARNING: **Addressed by id, never as "the first `<select>`".** This used to be
     * `selectOption('select', …)`, which is only correct while the section picker happens to be the
     * first select on the page - it stops being that as soon as another one renders. The grid
     * assertions below are positional, so picking the wrong section failed as a *content* mismatch
     * and read like a product bug in the timetable. The control now has an id (and a real label).
     */
    /**
     * WARNING: **Verifying the SELECT is not enough — the grid can lag behind it, or be reset.**
     * `/timetable` sets its section from `coverage()` when that fetch resolves (`if (!sectionId)
     * setSectionId(sections[0])`), and loads the grid from a second request after that. So a
     * selection made while those are in flight can be overwritten, or leave the previous section's
     * grid on screen — which is how this spec came to assert clock times belonging to the school's
     * REAL "Regular" schedule and report it as a timetable bug.
     *
     * Retry until the GRID itself says it is rendering this spec's schedule; that is the only
     * signal that the page has actually caught up with the selection.
     */
    await expect(async () => {
      await page.selectOption('#tt-section', section.id);
      await expect(page.locator('#tt-section')).toHaveValue(section.id);
      await expect(page.getByText(`Periods and times come from`)).toContainText(NAME, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    /**
     * The grid says whose day it is rendering — and this now checks WHICH, not merely that the
     * sentence exists.
     *
     * WARNING: **asserting only the phrase is what let this spec read someone else's timings.**
     * `resolveForClass` falls back to the campus DEFAULT schedule when a class has no attachment,
     * so a grid rendered from the wrong schedule looks perfectly healthy — the sentence is there,
     * the times are real — and the failure lands three lines later as a mismatched clock value that
     * reads like a bug in the timetable. Naming the schedule turns that into "you are looking at
     * the wrong one", which is the actual fault.
     */
    // (Already proven by the retry above — kept as the statement of intent for the reader.)
    await expect(page.getByText(`Periods and times come from`)).toContainText(NAME);

    // Monday period 3 exists and carries a real clock time; Friday period 3 does not exist at all.
    // ⚠️ Asserting only "Friday is empty" would have passed on the OLD behaviour too — an
    // unfilled cell and an absent one look the same until you ask which one you can click.
    const rows = page.locator('tbody tr');
    await expect(rows.nth(2).locator('td').nth(1)).toContainText('09:20');
    await expect(rows.nth(2).locator('td').nth(5)).toHaveText('—');
    await expect(rows.nth(0).locator('td').nth(5)).toContainText('08:00');
  });
});
