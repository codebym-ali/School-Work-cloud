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
      try { await apiSetupDelete(page, `/sections/${id}`); } catch { /* ignore */ }
    }
    for (const id of created.classes.splice(0)) {
      try { await apiSetupDelete(page, `/classes/${id}`); } catch { /* ignore */ }
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
    await page.selectOption('#tm-schedule', schedule.id);

    for (const row of MONDAY) {
      await page.getByRole('button', { name: row.teaching ? '+ Add period' : '+ Add break' }).click();
    }
    for (let i = 0; i < MONDAY.length; i++) {
      await page.getByLabel(`Minutes, row ${i + 1}`).fill(String(MONDAY[i].minutes));
      if (!MONDAY[i].teaching) await page.getByLabel(`Break name, row ${i + 1}`).fill(MONDAY[i].label!);
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
    await page.selectOption('#tm-schedule', schedule.id);
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
    await page.selectOption('select', section.id);

    // The grid says whose day it is rendering. Under the old inferred shape there was no such
    // sentence, because there was nothing to name.
    await expect(page.getByText(`Periods and times come from`)).toBeVisible();

    // Monday period 3 exists and carries a real clock time; Friday period 3 does not exist at all.
    // ⚠️ Asserting only "Friday is empty" would have passed on the OLD behaviour too — an
    // unfilled cell and an absent one look the same until you ask which one you can click.
    const rows = page.locator('tbody tr');
    await expect(rows.nth(2).locator('td').nth(1)).toContainText('09:20');
    await expect(rows.nth(2).locator('td').nth(5)).toHaveText('—');
    await expect(rows.nth(0).locator('td').nth(5)).toContainText('08:00');
  });
});
