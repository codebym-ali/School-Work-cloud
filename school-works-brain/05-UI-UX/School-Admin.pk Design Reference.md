# School-Admin.pk — design reference

**Captured 2026-08-14** from the live site (https://school-admin.pk) plus an operator screenshot of
the product dashboard. Tokens below are **read from the compiled CSS**, not eyeballed from an image
— so they are exact, not approximations.

Stack: **Next.js + Tailwind v4** (`@theme` tokens compile to `--color-*` custom properties),
self-hosted fonts via `next/font`. No dark-mode class on the marketing site; the **app** has a
dark toggle (visible in the dashboard screenshot), so dark is an app-level concern.

---

## 1. Brand palette

The identity is **navy + amber-gold** — a serious institutional blue warmed by a single accent.

| Token | Hex | Where it does the work |
|---|---|---|
| `--color-brand-blue` | **`#234777`** | Primary. CTA fills, headings, nav links, card header bars |
| `--color-brand-blue-dark` | `#152b4a` | Hover/pressed, deep section fills |
| `--color-brand-navy` | `#152b4a` | Same value, semantic alias |
| `--color-brand-blue-tint` | `#eef2f8` | Page background, subtle panels |
| `--color-brand-orange` | **`#df9118`** | Accent. Badges (`pro`), avatar, highlight numbers |
| `--color-brand-orange-light` | `#f5b84a` | Hover on accent |
| `--color-brand-orange-dark` | `#b8740f` | Pressed on accent |
| `--color-brand-orange-tint` | `#fdf4e3` | Accent chip backgrounds |
| `--color-brand-dark` | `#1a1a2e` | Body text / section headings |
| `--color-brand-muted` | `#6b7280` | Secondary text, labels |
| `--color-brand-light` | `#9ca3af` | Tertiary text, placeholders |
| `--color-brand-border` | `#e5e7eb` | Hairlines, dividers, card edges |

**Semantic (status) colours** come from a lightly-customised Tailwind scale, not the brand ramp:

| Meaning | Value | Seen on |
|---|---|---|
| Positive / income | `--color-green-500` **`#00c758`** | Cashflow income line, PRESENT, collected fees |
| Negative / expense | `--color-red-500` **`#fb2c36`** | Expense line, ABSENT, pending |
| Warning / attention | `--color-orange-500` **`#fe6e00`** | LATE, pending amounts |
| Informational | `--color-blue-500` **`#3080ff`** | Neutral stats, LEAVE |
| Alt-positive | `--color-emerald-500` `#00bb7f` | Secondary success |

⚠️ **Note the greens are unusually saturated** (`#00c758`, not Tailwind's stock `#22c55e`) — the
palette was tuned, so copying stock Tailwind will look subtly off-brand.

---

## 2. Typography

**Two families, deliberately split by role** — both self-hosted:

- **Roboto Slab** → `--font-heading`, applied with `font-heading`. All display and section headings.
- **Roboto** → `font-body` on `<body>`. All UI, tables, labels, numbers.

A slab serif for headings against a neutral sans for data is the site's most distinctive typographic
choice: it reads institutional (school, register, ledger) without looking corporate.

**Scale** (Tailwind default ramp, `--text-*`): `xs .75` · `sm .875` · `base 1` · `lg 1.125` ·
`xl 1.25` · `2xl 1.5` · `3xl 1.875` · `4xl 2.25` · `5xl 3` · `6xl 3.75` · `7xl 4.5` · `8xl 6` rem.

**Observed usage (computed, live):**

| Role | Size | Weight | Colour |
|---|---|---|---|
| Hero H1 | `5xl` → `7xl` → `8xl` responsive (96px at desktop) | 800 extrabold | `#234777` |
| Section H2 | 48px (`5xl`) | 700 | `#1a1a2e` |
| Card title H3 | 20px (`xl`) | 700 | `#234777` |
| Nav link | 14px (`sm`) | 600 | `#234777` |
| Button label | 14px (`sm`) | 700 | white on fill |
| Body | 16px (`base`) | 400 | `#1a1a2e` |

Hero uses `tracking-tight` and `leading-[1.1]` — tight display setting, normal body setting.

---

## 3. Buttons

**Primary CTA is a pill, not a rounded rect** — the single most copyable detail:

```
background : #234777        border-radius: 9999px (full)
color      : #ffffff        padding      : 8px 24px
font-size  : 14px           font-weight  : 700
transition : all
```

**Secondary / nav item:** transparent fill, `#234777` text, **8px** radius, `8px 16px` padding,
weight 600. So the system uses **two different radii by rank** — pill for actions, small radius for
navigation. Icon-only buttons use **12px** radius with `8px` padding.

---

## 4. Shape, elevation, motion

**Radii:** `md .375rem` · `lg .5rem` · `xl .75rem` · `2xl 1rem` · `3xl 1.5rem`, plus `full` for
pills. Cards in the dashboard read as `xl`–`2xl`.

**⚠️ Shadows are brand-tinted, never neutral black.** This is the signature that makes the UI feel
designed rather than assembled:

| Shadow | Use |
|---|---|
| `0 10px 30px -10px #2347771a` | Resting card — a whisper of blue |
| `0 8px 32px #23477733` | Raised / hovered card |
| `0 10px 30px #df911866` | Accent button glow |
| `0 0 20px #df9118` | Accent emphasis |
| `0 0 100px #23477780` | Ambient hero glow |
| `0 0 8px #22c55e99` | Live status dot (the green "OPEN" pill) |

**Spacing base:** `--spacing: .25rem` (4px grid).
**Motion:** `transition: all` with `duration-300` on the body; only stock Tailwind keyframes
(`spin`, `ping`, `pulse`, `bounce`) — no bespoke animation library.

---

## 5. Dashboard anatomy (from the operator screenshot)

**Three-zone shell:** fixed left sidebar (white) · top utility bar · scrolling content on a very
light blue-grey field (`--color-brand-blue-tint` family).

**Sidebar** — white, school crest and name at top, uppercase `MENU` label in muted grey, then
grouped nav (Dashboard, Academic, Students, HR, Finance, Attendance) with chevrons for expandable
groups. The open group's children are indented with small icons. **Locked features carry a small
orange `pro` pill** — upsell built into the navigation. Footer line: `© 2021-2026 School-Admin.pk`.

**Top bar** — hamburger (collapse), then horizontal quick links (Student List, Daily Diary,
Attendance, Fees, Expenses, Reports), right side has a dark-mode moon toggle and a circular
**orange avatar** with the user's initial.

**Card pattern** — the workhorse. A **solid navy header bar** (`#234777`) with a white icon and
white bold title, joined to a white body. Rounded `xl`, brand-tinted shadow. Every panel on the page
uses it, which is what makes the dashboard read as one system.

**Content blocks observed:**
- *School Timing* — green `OPEN` status pill; check-in/check-out rows with the time right-aligned,
  in-time green, out-time red.
- *Today's Birthdays* — two big count tiles (students / employees) then name chips.
- *Finance Summary* — label/value rows, each with a directional arrow icon; **value colour carries
  the meaning** (green income, red expense, orange pending).
- *Cashflow Analysis* — dual-series area/line chart, green income over red expense, soft green fill,
  legend as coloured dots, 6-month x-axis.
- *Fee Report* — Expected / Collected / Pending as stacked rows in blue / green / red.
- *Student Statistics* — three headline tiles with **circular filled icon badges** (blue, green,
  orange) beside a large number and a small uppercase caption; below, a four-up strip of
  Present / Absent / Leave / Late in blue / red / green / orange, then an attendance-rate pill.
- *Recent Activity* — circular status icon, title, relative timestamp, amount right-aligned and
  colour-coded.
- *Upcoming Holidays* — date chip (day over month) in brand colour beside name and weekday.

**Numeric style:** money always `Rs 1,850,000.00` — currency prefix, thousands separators, two
decimals, right-aligned in rows.

---

## 6. What to copy if we adopt this look

1. **The two-font split** (Roboto Slab headings / Roboto body) — biggest character-per-effort win.
2. **Navy header bar on every card.** Cheap, and it is what unifies the dashboard.
3. **Brand-tinted shadows** instead of black — the difference between "designed" and "bootstrapped".
4. **Colour as meaning, consistently**: green = money in / present, red = money out / absent,
   orange = attention / pending, blue = neutral. Never decorative.
5. **Pill primary CTA, 8px secondary** — rank expressed through shape, not just colour.
6. ⚠️ **Take the tuned palette values, not stock Tailwind** — their green and orange are shifted.

**Accessibility check before adopting:** `#234777` on white is ~8.6:1 (excellent). But
`--color-brand-orange` `#df9118` on white is roughly **2.4:1 — below the 4.5:1 minimum for text**.
It is safe as a *fill* behind white text or as an icon/badge, and must not be used for small text on
a light background. The dashboard's orange numerals (840 FAMILIES, 20 LATE) sit right at that edge.
