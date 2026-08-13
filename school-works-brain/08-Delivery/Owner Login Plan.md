# Owner Login Plan (O0–O4)

**Raised by the operator, 2026-08-12:** *"owner should have a separate login page from all those — no
other user should use that login page."*

**Status:** ✅ **COMPLETE — O0–O4 shipped 2026-08-12**, all eight invariants satisfied. The pre-existing lockout defect found during the build was fixed the same day (§Was blocked).
Decisions taken 2026-08-12 (§Decisions); nine security findings folded into the phases (§Audit).

## What exists today

Three login pages, split by **credential type**, not by role:

| Page | Who | Credential | Endpoint |
|---|---|---|---|
| `/login` | every school user — owner, campus admin, teacher, accountant, admission officer, HR, staff | email + password | `POST /auth/login` |
| `/student-login` | students | registration number + CNIC/B-Form | `POST /portal/auth/login` |
| `/admin/login` | the platform/vendor admin | email + password | `POST /platform/auth/login` |

`/admin/login` is a genuine boundary: a separate `PlatformUser` table with no RLS, its own cookies
(`platform_access_token` / `platform_csrf`) and a `typ:'platform'` JWT. **The owner is not that** —
they are a tenant user and must keep the same session, cookies and API. So this plan adds a
**door**, not a second identity system.

---

## What this is actually worth

**Splitting the door does not shrink the attack surface.** Both doors accept passwords, and what
stops a brute force is already in place: argon2, lockout, §29 rate limiting, and mandatory MFA for
`OWNER_ADMIN`. The payoff is that a separate door is **one choke point you can harden later** — a
stricter limit, an IP allowlist, a hardware key — without touching how 400 teachers sign in, plus
the organisational benefit that staff never see the owner's entrance. **Build it for that. Do not
expect the split alone to add security.**

---

## Design invariants

Every phase must honour these. They are the corrected output of the audit, stated once so no phase
has to re-derive them.

**I1 · The refusal must be indistinguishable from a wrong password — in body *and* in work done.**
A door that refuses the wrong people is an oracle otherwise: at `/owner-login` it tells an attacker
with any staff credential who the owner is; at `/login` it leaks **which address is the owner's**,
the single most valuable fact about a school. `AuthService.login` already has this discipline for
email existence (§22.3) — it dummy-hashes a fake argon2 digest so a missing user costs the same as a
real one. The new rule lands **inside** that discipline: same `invalid()`, same code, same message,
same status, **same database writes**.

**I2 · The door check sits between password verification and the MFA branch.** Not "somewhere after
the password". `mfaChallenge()` issues a real session to anyone holding a valid `mfaToken`, and
`login()` hands that token out *before* issuing a session — so a check placed after the MFA branch
is a **complete bypass**, not a leak (S2). This ordering is what makes I3 true.

**I3 · One enforcement point, inherited transitively.** Three call sites reach `issueSession`:
`login`, `studentLogin`, `mfaChallenge`. `refresh` re-issues from an existing refresh token;
`resetPassword` issues nothing. So the rule belongs **only** inside `login` — an `mfaToken` and a
refresh token can only originate from a door that already ran it. **This guarantee holds only while
I2 does.**

**I4 · A wrong-door attempt is a failed login, exactly like a wrong password.** Same
`registerFailure()`, same database write, same lockout arithmetic. Skipping the write is what
reintroduces the timing oracle (S1).

**I5 · `door` is a required parameter with no default.** A default is how a bypass ships: a new
caller omits it and silently authenticates against the permissive door. Required means the compiler
asks the question.

**I6 · Holding `OWNER_ADMIN` routes you to the owner door, whatever else you hold.** The tempting
alternative — "allowed at the staff door if they also hold a staff role" — lets an owner keep
`/login` by holding a second role, and the boundary evaporates. Matches `usesTeacherShell()`, which
already excludes anyone with `OWNER_ADMIN` from the teacher app.

**I7 · One shared rate-limit bucket.** The key is `rl:{policy}:{scope}:{id}` — derived from the
**policy, not the route** — so two endpoints both on `@RateLimit('login')` share one bucket: 5
attempts across both doors, not 5 each. A separate policy name would *halve* brute-force protection.

**I8 · A wrong-door attempt with a correct password is audited.** It is a high-signal event — a
confused owner, or someone probing a credential they should not hold. `login()` currently writes no
audit record at all (verified), so this is new. ⚠️ The record is internal and must never change the
client response (I1).

---

## O0 — The owner door (backend, additive) — **SHIPPED**

`POST /auth/owner-login` — its own controller method, `@Public()` + `@RateLimit('login')` (I7).

Reuses `AuthService.login` with a required `door` argument (I5) rather than duplicating it: the
login path carries lockout, self-healing locks, failure counting and the MFA hand-off, and a second
copy would drift from all of it.

```
login(dto, res, door: 'staff' | 'owner')        // required, no default (I5)
  … lookup + dummy-hash + lock handling, unchanged …
  const ok = verify(password)
  if (!ok) { registerFailure(user); throw invalid() }

  if (!doorAllows(door, user.roles)) {          // ← I2: BEFORE the MFA branch
    await registerFailure(user)                 //    I4: same write, same cost
    await audit.record(WRONG_DOOR, …)           //    I8: internal only
    throw invalid()                             //    I1: byte-identical
  }

  if (user.mfaEnabled) return { mfaRequired, mfaToken }
  …
```

`doorAllows`: `owner` ⇒ roles include `OWNER_ADMIN`; `staff` ⇒ they do not (I6).

**Acceptance — each of these is a test, not a comment**
- An `OWNER_ADMIN` signs in at the owner door and gets the same session, cookies and MFA hand-off
  as before.
- A teacher with a **correct** password gets a response byte-identical to a wrong password.
- **A non-owner with MFA enabled gets `INVALID_CREDENTIALS` and never an `mfaToken`** — the S2
  bypass, asserted directly rather than trusted to code order.
- A wrong-door attempt increments `failedLoginCount` exactly as a wrong password does — proven by
  **reading the counter**, not by timing (I4).
- Both doors share one `rl:login:ip:*` bucket: 5 attempts across both, not 5 each (I7).
- A user holding `OWNER_ADMIN` **and** `TEACHER` is refused at the staff door and admitted at the
  owner door (I6).
- The wrong-door attempt produces an audit record, and the HTTP response is unchanged (I8).

**Probe:** delete the `doorAllows` call — the door tests must fail. Then move it *after* the MFA
branch — the non-owner-with-MFA test must fail while the others still pass. **A probe that only
proves "it still refuses" would miss the bypass entirely.**

*Cost accepted (I4):* an owner who forgets and uses `/login` five times locks their own account.
That is the usability price of closing a timing channel; the standing link on the page (O1) is what
stops it happening.

---

## O1 — The page and the routing — **SHIPPED**

`/owner-login`, in the same public group as `/login` and `/student-login`, same tenant-by-host
resolution. Owner-branded; on success uses the existing `landingPath` (owner → `/dashboard`), so
nothing about the post-login world changes.

**MFA is already covered** — `OWNER_ADMIN` is in `MFA_REQUIRED_ROLES`, so the door inherits the
standing two-factor requirement rather than needing its own.

**Discoverability — link it from `/login`.** ⚠️ Not hidden: obscurity is not a control here (the
route ships in the JS bundle either way), and an owner who cannot find their own door telephones you
on a Sunday. Follows the pattern already on that page: a discreet *"School owner? Sign in here →"*,
matching *"Student? Sign in with your registration number →"*.

**⚠️ The way out must be on the page, never in the error.** By I1 a mis-routed person gets an
indistinguishable failure and therefore **no hint**. So `/owner-login` carries a standing
*"Staff or teacher? Sign in with your email →"* — visible **before** anyone fails. This is the
design consequence of the security rule, not a nicety.

---

## ✅ Was blocked — I4 and I8 now hold (fixed 2026-08-12, same day)

**Found while building O0, and it is pre-existing, not caused by it.**
`TenantTransactionInterceptor` opens **one `$transaction` per request**, and a failed login
**throws** — so `registerFailure()`'s write is rolled back along with everything else.
`failedLoginCount` never rises, and **§22.3 lockout (10 attempts → 15-minute lock) has never fired
in a running system.** Proven with a control test against the untouched `/auth/login` path: a wrong
password leaves the counter at 0.

Consequences for this plan:
- **I4** (a wrong-door attempt counts as a failed login) — the write is made and rolled back.
- **I8** (the attempt is audited) — same rollback, and **this one matters more**: the audit row is
  the only trace a wrong-door attempt leaves, because the caller is deliberately told nothing. Until
  it is fixed, **the door ships with no visibility into who is testing it.**
- **I1 is NOT affected, which is why O0 was still worth shipping.** Both paths perform the same
  write and both roll it back, so they remain indistinguishable and no timing oracle appears.

**Fixed on the operator's instruction rather than deferred**, because a lockout that never locks is
a live brute-force exposure and it also unblocks this plan. `TenantPrismaService.outsideRequestTransaction()`
gives failure-path writes a tenant transaction of their own; `registerFailure()`, the lock self-heal
and the wrong-door audit all use it. The three `it.failing` markers are gone — they are ordinary
passing tests now — and **§22.3 lockout finally has a test**: ten wrong passwords must leave the
account `LOCKED` and refuse an otherwise-correct password.

**I4 and I8 hold. All eight invariants are now satisfied.**

---

## O2 — The staff door refuses owners — **SHIPPED**

Without this an owner can still sign in at `/login` and the separation is **branding only**. With
it the two doors are mutually exclusive and the boundary is real. **In scope by decision (§1).**

Backend is one line — `door: 'staff'` on the existing route, with `doorAllows` already written in
O0. **⚠️ The mirror-image oracle applies**: `/login` refusing an owner must be indistinguishable
from a wrong password (I1), or the staff page becomes an owner-detector — the exact leak O0 exists
to prevent, reintroduced from the other side.

**⚠️ The cost is the test suite, measured: `/auth/login` is called from 37 files, with 42 owner
sign-ins, and there is no shared login helper — every integration spec hand-rolls its own.** It also
gates `test/e2e/auth.setup.ts`, which every Playwright spec depends on, plus the seed scripts. A
missed edit fails loudly (good); a wrongly-edited one passes while testing the wrong door (bad).

**Do the refactor the change deserves rather than 37 hand edits:** add one `loginAs()` helper in
`test/integration/support/`, move every spec onto it, and let it pick the door from the role. That
turns "37 places to get right" into one, and leaves the suite better than it found it — the same
argument that retired the three hand-copied `drainSms` helpers.

⚠️ **This changes how the operator signs in.** After O2, `owner@demo.pk` stops working at `/login`.
That is the point, and it will feel like a breakage the first time.

---

## O3 — Matrix, gates, brain — **SHIPPED**

- ⚠️ **No permission-matrix rows — and this reverses the plan's own instruction.** O3 said *"rows for
  both doors; a route with no row is unmeasured, not safe."* The harness cannot measure these: it
  drives every row with a **role's session cookie** and asserts 403 vs not-403, while a login route
  is `@Public()`, takes *credentials*, has no session to present, and refuses the wrong door with
  **401 — deliberately indistinguishable from a wrong password**. A row would assert nothing while
  looking like coverage, **which is worse than the gap it appears to close.** The boundary is
  measured directly in `auth.e2e-spec.ts` instead, and `permission-matrix.ts` carries a note saying
  so where a reader would look for the missing rows. *Measured by a different instrument, not
  unmeasured.*
- Full gates: unit · integration · isolation · Playwright · lint · typechecks · builds.
- Brain — Key Decisions: why the refusal must be indistinguishable *in work done as well as in
  wording* (I1/I4); why the check must precede the MFA branch or it is a bypass (I2); why one
  enforcement point suffices (I3); why one shared rate-limit bucket (I7). Progress Tracker; §23 role
  table.
- Record **S7 and S9 as open** (below) so the pen test inherits them.

---

## O4 — Route naming: three named doors behind one neutral `/login` — **SHIPPED 2026-08-12**

Operator asked to rename the doors. The proposal was `/management-login`, `/school-admin/login`,
`/student-login`; **three objections were raised and two of them changed the outcome.**

- ⚠️ **`/school-admin/login` was dropped: it sits one word from `/admin/login`, the VENDOR
  console** — a separate `PlatformUser` table with no RLS, its own cookies and a `typ:'platform'`
  JWT. Confusing those two in a runbook, a bookmark or a firewall rule is easy and the consequence
  is not cosmetic. (The instinct was sound though: `OWNER_ADMIN`'s UI label *is* "School Admin".)
- **Grammar made consistent.** Mixing `/x-login` with `/x/login` invites a guess and a 404.
- **"Management" excluded most of that door's users** — it serves teachers and office staff as much
  as managers. `/staff-login` says who it is for.

⚠️ **The naming was the smaller half. `/login` cannot be a door at all** — it is the redirect
target for every 401 and every logout (`(app)/layout` ×2, `me-more`, the root page) and for the
per-campus links `?campus=`. At that moment the visitor is **signed out, so nothing knows their
role**, and since O2 the doors refuse each other's people — so whichever form sat there would
refuse somebody on every session expiry. **A signed-out owner bounced onto the staff form, refused
by a message that deliberately explains nothing, is the concrete case.**

So: `/staff-login`, `/owner-login`, `/student-login` are the doors, and **`/login` is a chooser**
that names all three. Every existing redirect and bookmark keeps working, and the campus name is
forwarded to the staff door only — an owner belongs to no campus and a student signs in with a
registration number.

⚠️ **A guard broke silently in the move and had to be caught by reading, not by running:** three
specs waited with `!pathname.startsWith('/login')`, which `/staff-login` does not match — so the
wait would have passed *before the form was ever submitted*. Now `!endsWith('-login')`.

---

## 🔒 Security audit (2026-08-12)

Audited against the real `AuthService`, not against this plan's prose. **Two findings were defects
in the plan as first written; one would have shipped a bypass rather than a leak.** All are now
folded into the invariants above.

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | HIGH | "Don't count the wrong door as a failure" reintroduced the oracle. A wrong password runs argon2 **and `registerFailure()`, a database write**; the planned wrong-door path returned immediately. Same body, **different duration**, measurable over a few hundred samples. The stated reason was also wrong: locking an account with bad passwords is *already* possible at `/login`, so counting adds no new exposure. | **Fixed — decision reversed** → I4 |
| S2 | CRITICAL | Ordering makes this a bypass, not a leak. `mfaChallenge()` issues a real session to anyone with a valid `mfaToken`, and `login()` emits that token *before* issuing a session. A door check placed after the MFA branch lets a non-owner with MFA take an `mfaToken` from the owner door and complete the challenge — **a full session through the door that refused them**. | **Fixed** → I2, plus a dedicated test + probe |
| S3 | MEDIUM | Every session-issuing path must be enumerated. Done: `login`, `studentLogin`, `mfaChallenge` reach `issueSession`; `refresh` re-issues from an existing token; `resetPassword` issues nothing. One enforcement point suffices — **only while S2 holds**. | **Resolved** → I3 |
| S4 | MEDIUM | A `door` parameter with a default is how a bypass ships — a new caller omits it and gets the permissive door. | **Fixed** → I5 |
| S5 | MEDIUM | `login()` writes **no audit record at all** (verified). A correct password at the wrong door is high-signal and would have been invisible. | **Fixed** → I8 |
| S6 | LOW | Linking the owner door narrows the brute-force keyspace to **owner accounts only** — smaller and far more valuable than "any staff address". | **Accepted**: obscurity is not a control, MFA is mandatory for owners, bucket is shared. Revisit when an IP allowlist lands. |
| S7 | LOW | **Pre-existing.** `ACCOUNT_LOCKED` is thrown *before* password verification and is a distinct error, so it already reveals that an address exists. | **Open, out of scope.** ⚠️ This plan therefore **cannot claim to be "fully enumeration-safe"**. Worth its own ticket. |
| S8 | MEDIUM | Multi-role users needed a stated rule, or an owner keeps `/login` by holding a second role. | **Fixed** → I6 |
| S9 | LOW | The 10/email/1h rule is a cheap denial-of-service on the owner's now-**only** door. Unchanged in kind, but the split removes any fallback. | **Accepted**, noted for the pen test. |

---

## Decisions — taken 2026-08-12

1. ✅ **Strict.** The staff door is closed to owners: `OWNER_ADMIN` signs in only at `/owner-login`,
   everyone else only at `/login`. **O2 is in scope**, with the `loginAs()` refactor — a "separate"
   door the owner need not use is a label, not a boundary.
2. ✅ **One shared rate-limit bucket** (I7). No owner-specific policy; the choke point stays
   available for later hardening without changing the limiter today.
3. ✅ **Path:** `/owner-login`, matching `/student-login`.
4. ✅ **School-wide, no `?campus=`.** An owner belongs to no campus — `restrictedCampusId()` returns
   `null` for exactly that reason — so campus branding has no meaning on this door.

## Build order

**O0 + O1 as one branch** — a working owner door, nothing disrupted, no test churn.
**O2 + O3 as a second** — the half that changes the operator's own habits and touches ~37 files.
