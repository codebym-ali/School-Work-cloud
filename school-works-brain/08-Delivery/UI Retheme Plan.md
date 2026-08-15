# UI Retheme Plan (U0–U5)

**Raised by the operator, 2026-08-14**, after capturing the
[[School-Admin.pk Design Reference]] — apply that design language to `apps/web`.

**Status:** ✅ **COMPLETE — U0–U5 shipped 2026-08-15.** Both pre-U0 decisions were taken as
recommended (§Decisions taken below), and the values in this plan were **superseded during U0** to
differentiate from the competitor — the palette below is the reference's, not ours. See
§What shipped for the values actually in the stylesheet.

---

## The finding that shapes everything

`apps/web` has **no Tailwind**. It is one hand-rolled `app/globals.css` (405 lines) driving a small
**semantic class vocabulary** — `.card`, `.sidebar`, `.metric`, `.badge`, `.chip`, `.toast`,
`.shell`, `.topbar`, `.row`, `.stack`, `.grid`, `.ghost`, `.section-title` — off eight CSS
variables.

⚠️ **That vocabulary is load-bearing for the test suite: 71 references across the Playwright specs**
(`.toast` 27, `.card` 22, `.sidebar` 11, `.badge` 8, `.error` 2, `.metric` 1).

So the shape of this work is decided by evidence, not taste:

> **This is a RETHEME, not a rewrite. Migrating to Tailwind utility classes would break the browser
> suite that gates every other change — 71 assertions — in exchange for nothing the variables cannot
> already do.**

The reference site *is* Tailwind, but what we are copying from it is a **design language**, not an
implementation. Most of its character lives in values (colour, type, radius, shadow) that a
variable-driven stylesheet expresses just as well, and in two component patterns we can add by hand.

---

## Design invariants

**K1 · The class vocabulary is a public API.** Retheme through `:root` variables and the existing
selectors. A class rename is a test change, and a test change to satisfy a restyle is how a green
suite stops meaning anything.

**K2 · Contrast is a requirement, not a preference.** Measured: `#234777` on white ≈ **8.6:1**
(excellent). `#df9118` on white ≈ **2.4:1 — below the 4.5:1 floor for text.** Orange is a *fill*
behind white text, a badge, or an icon. **It is never text on a light background**, however much the
reference does it (its own `840 FAMILIES` numeral sits under the floor).

**K3 · The teacher shell must not regress.** Four tabs at 375px, `TeacherSidebarNav` at desktop,
`/home` reachable from every screen. That took five phases (T0–T4) to get right, and a restyle is
exactly how it silently breaks — the shell is CSS, not logic.

**K4 · Every phase is looked at in a browser, at three widths.** Tests prove structure, not
appearance. This project has twice shipped UI defects that compiled, passed and were only visible on
screen. **A retheme cannot be verified by a green suite.**

**K5 · Dark mode is out of scope.** The reference dashboard has a toggle; `globals.css` has **no**
dark support at all — no `prefers-color-scheme`, no `data-theme`. Adding it during a retheme doubles
the surface being changed and halves the confidence in both. Do it after, as its own phase, on
tokens that are already stable.

---

## U0 — Tokens *(do this first; it carries most of the visual change)*

Replace the eight variables with the full system. **No component edits, no markup changes** — every
screen shifts at once and the diff stays reviewable.

```css
:root {
  /* brand */
  --brand:            #234777;   /* was #3355cc */
  --brand-dark:       #152b4a;
  --brand-tint:       #eef2f8;
  --accent:           #df9118;
  --accent-light:     #f5b84a;
  --accent-dark:      #b8740f;
  --accent-tint:      #fdf4e3;
  /* surface + ink */
  --bg:               #eef2f8;   /* was #f6f7f9 — a blue-grey field, not neutral */
  --card:             #ffffff;
  --ink:              #1a1a2e;
  --muted:            #6b7280;
  --light:            #9ca3af;
  --border:           #e5e7eb;
  /* status — meaning, never decoration */
  --ok:               #00c758;
  --danger:           #fb2c36;   /* was #c0392b */
  --warn:             #fe6e00;
  --info:             #3080ff;
  /* shape */
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-xl: 16px; --r-pill: 9999px;
  /* elevation — brand-tinted, never black (this is the signature) */
  --shadow-card:  0 10px 30px -10px rgb(35 71 119 / .10);
  --shadow-raise: 0 8px 32px rgb(35 71 119 / .20);
  --shadow-accent:0 10px 30px rgb(223 145 24 / .40);
  --glow-live:    0 0 8px rgb(0 199 88 / .60);
}
```

⚠️ **Take the tuned values, not stock equivalents.** Their green is `#00c758`, not `#22c55e`;
substituting the familiar one reads subtly wrong beside everything else.

**Acceptance:** every screen re-colours; no markup changed; Playwright still green (it asserts
classes and text, not colour); a browser pass confirms nothing became unreadable.

---

## U1 — Typography

Two families, split by role, via `next/font` (self-hosted, no external request — the CSP on this app
would block a CDN anyway):

- **Roboto Slab** → headings, `.section-title`, card titles, metric numerals.
- **Roboto** → body, tables, labels, form controls.

Replace the current `-apple-system, BlinkMacSystemFont…` stack. Set the scale explicitly:
body 15→**16px**, `.section-title` 20px/700, page H1 24–30px/800, metric value 28–32px/800,
`.label` 11px uppercase with `letter-spacing: .04em`.

**This is the highest character-per-byte change in the whole plan.** A slab serif over a neutral
sans is what makes the reference read as a school ledger rather than a generic admin panel.

---

## U2 — The card header bar *(the signature pattern)*

The reference's single most repeated device: a **solid navy header** with a white icon and bold
white title, joined to a white body. It is what makes twelve unrelated panels read as one system.

Add **alongside** `.card`, never replacing it (K1):

```css
.panel { background: var(--card); border-radius: var(--r-lg); box-shadow: var(--shadow-card);
         border: 1px solid var(--border); overflow: hidden; }
.panel > header { background: var(--brand); color: #fff; padding: 12px 16px;
                  display: flex; align-items: center; gap: 8px; font-weight: 700; }
.panel > .body { padding: 16px; }
```

Applied to the dashboard's panels, the fee plan cards, and the campus cards. ⚠️ **`.card` keeps its
current meaning everywhere else** so the 22 test references stay valid.

---

## U3 — Components

- **Buttons.** Primary → `--brand` fill, **pill radius**, `10px 24px`, weight 700, white.
  `.ghost` → transparent, `--brand` text, `--r-md`, weight 600. **Rank expressed by shape, not only
  colour** — that is the reference's actual idea, and it survives translation.
  Destructive keeps `--danger`. Focus ring: `0 0 0 3px rgb(35 71 119 / .25)` — ⚠️ the current CSS has
  **no visible focus style**, which is a keyboard-accessibility gap this phase should close.
- **Badges.** `.badge.ok` green tint, `.badge.warn` amber tint, `.badge.bad` red tint — tinted
  background with dark text, so contrast holds (K2). Live status dot gets `--glow-live`.
- **Metrics.** Circular filled icon badge beside a large numeral and a small uppercase caption, per
  the reference's Student Statistics block. Numerals in `--brand`; **status colour only where the
  number means something** (present/absent/late), never for decoration.
- **Money.** One helper, `Rs 1,850,000.00` — prefix, separators, two decimals, right-aligned in
  rows. It is inconsistent today.
- **Tables.** Zebra-free, hairline `--border` rows, 12px uppercase muted headers, numerics
  right-aligned.

---

## U4 — Dashboard composition

Only after U0–U3 land. Re-lay the dashboard toward the reference's density: a stat strip
(present/absent/leave/late) under the headline tiles, finance rows where **the value's colour
carries the meaning**, a recent-activity list with colour-coded amounts and relative timestamps, and
an upcoming-holidays list with a date chip.

⚠️ **Composition changes touch markup, so this is the phase that can break tests.** Run the browser
suite per screen, not at the end.

---

## U5 — QA, accessibility and brain

- **Browser pass at 375 / 768 / 1440** on: dashboard, students, fees, classes workbench, campuses,
  teacher `/home`, the four login pages, `/me`.
- **K3 regression:** teacher shell — four tabs at 375, sidebar at 1440, `/home` reachable.
- **Contrast audit** of every final pair against 4.5:1; orange proven to appear only as fill/badge.
- **Focus-visible pass**: tab through one full form and one table.
- Full gates + brain (Key Decisions, Progress Tracker, and the reference doc cross-linked).

---

## Decisions needed before U0

**1. ⚠️ How close to school-admin.pk should we actually sit?**

They are a **direct competitor** — a Pakistani school-management SaaS. Design *patterns* (card
headers, colour-as-meaning, tinted shadows, a two-font split) are ideas and free to use. A wholesale
copy of their **exact palette and font pairing** is their visible identity, and adopting it verbatim
invites "this looks like School-Admin" from the schools we are both selling to — which helps them,
not us, since they are the incumbent with 500+ schools.

**Recommendation: take the patterns, shift the identity.** Keep the structure — navy + one warm
accent, tinted shadows, slab headings, colour as meaning — but move the hues enough to be ours: a
different navy (e.g. a cooler or deeper blue), and an accent that is not their amber. Costs nothing
extra during a token phase, and it is far more expensive to change after schools have seen it.

**2. Roboto Slab, or a different heading face?** Follows from (1). If we are differentiating,
another slab or a humanist serif gives the same institutional feel without the same fingerprint.

## Sequencing

**U0 → U1 → U2 → U3 → U4 → U5.** U0 and U1 are pure value changes and could ship together in a day;
U2–U4 are component work. Each phase: browser pass at three widths, full gates, brain updated with
the phase rather than after it.


---

## Decisions taken, and what shipped

**Decision 1 — how close to sit: patterns taken, identity shifted.** Structure kept (navy + one warm
accent, tinted shadows, slab-ish headings, colour as meaning); hues moved far enough to be ours.
⚠️ **So the hex values in U0 above are the REFERENCE's and are not what is in the stylesheet:**

| Role | Plan (theirs) | Shipped (ours) |
|---|---|---|
| `--brand` | `#234777` | **`#17365c`** |
| `--accent` | `#df9118` | **`#a1741c`** |
| Heading face | Roboto Slab | **Bitter** |

**Decision 2 — heading face: Bitter**, a slab with the same institutional feel and a different
fingerprint. Both families self-hosted via `next/font`; the CSP would block a CDN.

### What the build caught that the plan did not anticipate

- ⚠️ **K2 was already being met by 0.01, and the retheme broke it everywhere at once.**
  `--muted` `#6b7280` on the old `--bg` measured **4.51**. Darkening the field to `#eef2f8` took the
  same pair to **4.30** — every muted label on every screen, from one token move. The plan treated
  contrast as something to *check after*; the lesson is that a background token change is a
  contrast change to **every** pair sitting on it, and margin is the only defence.
- ⚠️ **The sidebar group labels were never legible** (3.28), which predates this work — the plan
  assumed existing pairs were sound and only new ones needed proving.
- ⚠️ **`app/manifest.ts` is a fourth home for the brand** and no phase owned it. `--brand` now
  lives in `globals.css`, `layout.tsx`, and `manifest.ts`; `installable.spec.ts` asserts all three.
- **`.panel` needed `padding: 0` to compose with `.card`.** A spec locates the staff panel as
  `.card`, so it must carry both classes — and `.card`'s 24px would inset the header bar that is
  meant to be flush. Fixed in the stylesheet rather than inline, so the next `.panel.card` composes.
- **`.panel > header a` had to be given an explicit white**, or a header link inherits
  `a { color: var(--brand) }` and renders navy on navy. Proven by injecting one: the identical
  anchor computes `#17365c` outside the header and `#fff` inside.
- **K4 paid for itself.** None of the above fails a test. The suite was green through every one.
