---
title: Fee submission — online, offline, and proof of payment
type: plan
status: B0–B6 SHIPPED 2026-08-04 (B6 as a seam only, deliberately) · decisions D1–D6 settled
created: 2026-08-04
scope: apps/api fees + uploads + portal · apps/web fees, students, /me · prisma
---

# Fee submission — how a Pakistani school actually collects money

> Operator: *"what are the options for online fee submission or manual fee submission with proof
> of fee paid, shown on the student portfolio — how should this be managed?"*

---

## 1. How fees are really paid here (the constraint the design must fit)

Ranked by what actually happens in a private school in Pakistan:

| # | Route | Reality |
|---|---|---|
| 1 | **Cash at the school office** | The default for small and mid-size schools. Receipt written on the spot; the receipt book *is* the record. |
| 2 | **Bank challan / voucher** | School issues a 3-part challan (school / bank / parent copy) carrying the student's name, GR and amount. Parent pays at a designated branch, brings back the stamped counterfoil. Office reconciles against the bank statement. |
| 3 | **IBFT / bank transfer** | Parent transfers from their bank app and **sends a screenshot on WhatsApp**. |
| 4 | **JazzCash / EasyPaisa** | Same pattern, mobile wallet. Very common for smaller amounts and for families without a bank account. |
| 5 | **Kuickpay / 1Bill / 1LINK PSID** | The modern aggregator route. The school gets a company code; each invoice gets a **consumer number (PSID)**; the parent pays inside *any* bank app under "Education / Fee"; money settles to the school account and the aggregator posts a webhook. This is what mid-to-large schools move to. |
| 6 | **Card gateway** (PayFast, Safepay) | Rare for tuition — higher MDR, and parents distrust entering card details for school fees. |

**Three operational truths that shape everything below:**

1. **A screenshot is a claim, not money.** The office reconciles against the *bank statement*. Routes
   3 and 4 are "trust, then verify" — and the verifying is the actual job.
2. **The receipt number matters.** A family's proof of payment is the school's receipt, and the
   sequence is gap-free per school on purpose. An unverified claim must never consume one.
3. **A cheque is not money until it clears.** Post-dated cheques are normal at admission time.

---

## 2. What the system has today

| Piece | State |
|---|---|
| `PaymentMethod` | CASH · BANK_TRANSFER · EASYPAISA · JAZZCASH · CARD · CHEQUE · ADVANCE |
| `FeePayment` | Gap-free per-school `receiptNo`, `transactionRef`, idempotency key, `SELECT … FOR UPDATE` row lock, partial unique on `[school, method, transactionRef]` — **the same bank reference cannot be recorded twice** |
| Receipt SMS | `FEE_RECEIPT` template already fires on payment |
| Upload pipeline | presigned PUT → magic-byte/MIME allowlist → **ClamAV** → quarantine→permanent (§22.6) |
| **Serving a file back** | ❌ **Does not exist.** `presignGet` is reachable only from inside the documents and payslip services — there is no general endpoint |
| Proof on a payment | ❌ Nothing |
| Unverified claim | ❌ No such concept — every recorded payment is instantly real |
| Parent portal | ❌ **Deliberately removed** ([[Key Decisions]], locked). A guardian is a contact record, not an account |
| Student portal fees | Invoice list only — no payments, no receipts, no proof |

### 2.1 The one blocker

**Nothing can serve an uploaded file back to a browser.** This already blocks student photos and
staff documents, and it blocks this. **One endpoint unblocks three features** — it is the first
thing to build regardless of which options are chosen below.

---

## 3. The central rule

> **A payment claim is not a payment.**

An unverified screenshot must never mint a receipt number, move `paidAmount`, appear in
collections, or clear a defaulter. Recording it as a `FeePayment` would corrupt the one number
the school's finances rest on — and the gap-free receipt sequence would be spent on a payment
that may never have happened.

So: a **`FeePaymentClaim`** is its own record with its own lifecycle, and verifying it is what
creates the real `FeePayment` — through the *existing* `pay()` path, so idempotency, the row
lock, the receipt sequence, the integrity check and the receipt SMS all continue to apply
unchanged.

```
  parent pays offline  →  CLAIM (PENDING)  ──verify──►  FeePayment  →  receipt no. + SMS
                              │                             (existing path, untouched)
                              └──reject──►  REJECTED + reason, visible to the submitter
```

---

## 4. Data model

```prisma
model FeePaymentClaim {
  id             String            @id @default(uuid())
  schoolId       String
  studentId      String            // the family pays for a CHILD, not for a row
  invoiceId      String?           // optional: often "this month's fee", sometimes several
  amount         Decimal           @db.Decimal(12,2)
  method         PaymentMethod
  transactionRef String?           // bank TID / wallet reference / challan number
  paidOn         DateTime          @db.Date        // what the parent says, not when they uploaded
  proofFileKey   String?           // null for cash at the office
  note           String?           @db.VarChar(300)

  status         ClaimStatus       @default(PENDING)   // PENDING | VERIFIED | REJECTED
  source         ClaimSource                           // OFFICE | STUDENT_PORTAL | GUARDIAN_LINK
  submittedById  String?           // null when it came through a tokenised guardian link
  reviewedById   String?
  reviewedAt     DateTime?
  rejectionReason String?          @db.VarChar(300)
  paymentId      String?           @unique            // set when verified — the audit bridge
}
```

- **`paidOn` is the parent's date, not the upload date.** A transfer made on the 8th and uploaded
  on the 12th was still made on the 8th, and the late-fee question turns on that.
- **`paymentId` is the bridge.** From any receipt you can reach the proof that justified it, and
  from any claim the receipt it produced. Without it, verification is unauditable.
- **Duplicate defence:** the same `transactionRef` must not be claimable twice. The partial unique
  on `fee_payments` already stops it at verification; the claim table gets the same check earlier,
  so a family that sends the same screenshot twice is told immediately rather than at the counter.

---

## 5. The channels — how a claim gets in

Three, and they are not alternatives; they stack.

### 5.1 Office-entered (build first, covers routes 1–4 today)

The clerk records the payment as now, **plus** an optional proof file: the WhatsApp screenshot,
the stamped challan counterfoil, the cheque image. For cash at the counter there is no proof and
none is asked for.

**Office-entered claims may be verified in the same action** — the clerk *is* the verifier, and
forcing a two-step review on the person who took the cash is bureaucracy, not control. What
matters is that the proof is attached and the audit says who.

### 5.2 Guardian link by SMS — ⭐ the recommended self-service route

The parent portal was removed deliberately, and **guardians are contact records, not accounts** —
that decision should not be reopened for this. But guardians *already receive fee SMS*.

So: the fee-due SMS carries a **signed, expiring, single-invoice link**:

> `Fee Rs 4,000 due 10 Aug for Ayesha. Pay & upload proof: sch.pk/p/kQ8x…`

The page needs **no login**: it shows the child's name, the invoice and the amount, and takes a
screenshot plus a reference number. It creates a `PENDING` claim, `source = GUARDIAN_LINK`.

Why this fits Pakistan specifically: the parent is already on WhatsApp with a screenshot in hand;
they do not want an account, will not remember a password, and often share one phone. It is the
lowest-friction thing that can exist, and it does not resurrect the portal.

**Security posture** (this is a public upload surface, so it is stated rather than assumed):
signed token bound to one invoice, short expiry, one-time-ish use, rate-limited per token and per
IP, existing magic-byte + **ClamAV** validation, images/PDF only, size-capped, and the token
reveals *only* the child's first name and the amount — never the full record.

### 5.2a What shipped, and the parts worth remembering (2026-08-04)

**Stateless token.** HMAC-SHA256 over `invoiceId.expiry` with a domain separator, 30-day TTL, no
token table. Nothing to leak, nothing to purge, no migration. Revocation is expiry, the
one-pending-claim rule, and the settings switch — which is a real kill switch, not decoration.

**Every rejection is the same 404.** Bad shape, bad signature, expired, wrong tenant, feature off.
Distinguishing them would build an oracle, and no legitimate guardian does anything different
with the difference.

**Tenancy is not carried by the token.** The school comes from the Host, so the invoice is read
inside that tenant's RLS transaction — a token minted for one school 404s on another's subdomain.
Verified live against a second tenant, not just asserted.

**The page shows a first name.** The link travels by SMS and gets forwarded; it has to be safe to
open in a group chat. No GR number, no surname, no guardian details.

**Uploads reuse the §22.6 pipeline** — MIME allowlist, quarantine prefix, magic bytes, ClamAV —
and the quarantine key is promoted *as part of* submitting, so no claim can ever reference an
unscanned object. Building a simpler path for the one surface strangers can reach would have been
exactly backwards.

**Rate limited on two axes** (per token *and* per IP, new `feeLink` policy). Per-token alone is
defeated by holding many tokens; per-IP alone by spreading across addresses.

**No AuditLog row for a link submission.** `userId` is NOT NULL with an FK to `users` because that
table attributes actions to a *person*, and here there is none. Inventing an actor would put a lie
in the trail; making the column nullable weakens it for every other action. The claim row is the
record, and verification is audited against the real cashier.

**Two defects the browser caught that types did not:**
- the link was built from `APP_APEX_DOMAIN` and came out as `:3000` where the web app serves
  `:3001`; then from the request Host, which the dev proxy rewrites to the API's port. Neither
  source is authoritative alone — the **tenant host** comes from the request, the
  **browser-facing port** from config. `.env` was also simply wrong and is corrected.
- `params` was typed as a `Promise` and read with `use()` (the Next 15 shape). It typechecked
  cleanly and crashed the page at runtime on Next 14. *A page that compiles is not a page that
  renders.*

### 5.3 Online gateway — design the seam, do not build it yet

For routes 5–6 the right integration is an **aggregator (Kuickpay / 1Bill / 1LINK)**, not a card
gateway: the parent pays inside their own bank app, which is what they already trust.

The seam:
- a **PSID / consumer number** derived per invoice (deterministic, e.g. school prefix + invoice
  sequence) and printed on the challan and the invoice;
- a **webhook** posting settlement, verified by HMAC — the SMS delivery webhook already
  establishes that pattern;
- settlement creates the `FeePayment` **directly** (money has moved; there is nothing to verify)
  with `method = ONLINE` and the aggregator's reference.

**Not built now** because it needs a signed merchant agreement, a company code and a sandbox —
none of which exist. The model carries the enum value and the invoice carries the PSID field so
the day it is signed is a wiring job, not a redesign.

### 5.3a What the seam is, and where it deliberately stops (2026-08-04)

Real and tested today:
- **`fee_invoices.psid`**, `VARCHAR(20)`, nullable, **unique per school** — Postgres treats NULLs
  as distinct, so every un-issued invoice coexists under the constraint. The migration was
  hand-curated: `migrate diff` tried to `DROP INDEX students_full_name_trgm` for the **eleventh**
  time, and `db:check-migrations` now fails the build on it rather than relying on someone reading
  the SQL.
- **`PaymentMethod.ONLINE`** — the one method that is not a claim. A guardian's screenshot is
  somebody's word; an aggregator callback is the bank saying the money moved.
- **`POST /webhooks/fee-settlement/:provider`** — public, HMAC-signed, rate-limited. The signature
  covers `psid.amount.aggregatorRef`, not just the PSID: signing the identifier alone would let
  anyone who saw one legitimate callback replay it for a different figure. **No secret configured
  ⇒ every call is refused**, so a half-configured deployment fails closed instead of trusting
  unsigned callers. Cross-tenant lookup is by PSID (the caller is a bank; there is no Host to
  resolve a tenant from), and the aggregator's reference is the replay guard, because banks retry.

**Where it stops, and why.** Writing the `FeePayment` needs an answer to *"who collected this?"*
and `collectedById` is NOT NULL with an FK to `users`, because that column exists to name the
clerk who took the money. A bank settled this; there is no clerk. All three shortcuts are worse
than stopping: taking an id from the callback body lets an **unauthenticated caller choose the
actor**; attributing it to the owner puts a lie in the ledger (the same reason the guardian link
writes no audit row); making the column nullable weakens it for every real payment. The right
answer is a per-school **service account for machine-made payments** — a product decision with an
owner, not something to invent inside a stub. Until then the endpoint returns a clear **501** so
nobody can mistake it for live.

**Verified live**, not only in tests: no secret → 403 · wrong signature → 403 · valid signature +
unknown PSID → 204 (silent ack, so an unauthenticated caller cannot enumerate PSIDs) · valid
signature + known PSID → 501.

---

## 6. Where it shows — the student portfolio

**Student profile (office view)** gains a **Fees** tab: invoices, payments with receipt numbers,
and proof thumbnails opening the stored image, plus any pending or rejected claims. This is the
"portfolio" in the operator's sense — one place showing what was owed, what was paid, and the
evidence.

**Student portal `/me/fees`** gains the paid side: each invoice's payments, **a downloadable
receipt**, and the status of anything submitted for them (*Submitted 12 Aug — awaiting
verification* / *Rejected: reference does not match our statement*). Read-only, self-scoped, as
that portal already is.

**Office queue** — a `Payment submissions` screen, and a dashboard chip: *"4 payments awaiting
verification →"*. Without it, claims arrive and nobody looks; the chip is what makes the workflow
real rather than a table.

**A receipt PDF** is worth including: `PdfService` already renders report cards, certificates and
payslips, and a receipt is what the family actually asks for.

---

## 6a. The owner chooses which of this the school uses ⭐

**Operator requirement:** none of the above should be forced on a school. A one-branch school
that takes cash over the counter must not be shown wallet references, challan numbers and an
upload queue it will never use.

So this follows the pattern the codebase already uses for `admissionsMode` and
`staffAttendance.*` — a **school-level setting group, opt-in, defaults conservative** — and it is
edited on the **School settings** screen the owner already has.

```ts
feeSubmission: {
  /** Which ways this school accepts money. Drives the collect-payment form AND the API. */
  methods: z.array(z.enum(['CASH','BANK_TRANSFER','EASYPAISA','JAZZCASH','CHEQUE','CARD']))
            .min(1).default(['CASH']),
  /** Attach a screenshot / challan counterfoil to a non-cash payment. */
  proofPolicy: z.enum(['OFF','OPTIONAL','REQUIRED']).default('OPTIONAL'),
  /** Guardians upload proof from a link in the fee SMS — no account, no portal. */
  guardianUploadLink: z.boolean().default(false),
  /** Days a cheque is held before it counts as money (D3). */
  chequeClearingDays: z.number().int().min(0).max(30).default(3),
  /** Aggregator (Kuickpay / 1Bill). Off until a merchant account exists. */
  online: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['KUICKPAY','ONEBILL']).default('KUICKPAY'),
    companyCode: z.string().max(20).optional(),
  }).default({}),
}
```

### What this changes on screen

- **Collect payment** offers only the methods the school accepts — a cash-only school sees one
  button, not a six-item dropdown of things it does not do.
- **Proof** is absent / optional / mandatory on non-cash according to `proofPolicy`, and the
  form says which.
- The **guardian link** section of the fee SMS, the public upload page and the verification queue
  **do not exist at all** unless `guardianUploadLink` is on — the same way the enquiry pipeline
  vanishes in DIRECT admissions mode rather than sitting there reading zero.
- The **online** block only appears once a company code is saved.

### ⚠️ Two rules about this configurability

**1. The API must enforce it, not just the UI.** A disabled method has to be *refused* by
`pay()`, not merely hidden from the dropdown. Hiding alone is a display gate over an open
endpoint — the exact mistake already recorded as **F8** in [[Fees Gaps Register]], where fee
prices are hidden in the UI but readable by anyone signed in.

**2. Turning a method off never rewrites history.** Payments already taken by cheque stay
readable, reversible and on the receipt after cheques are switched off. Disabling governs **new**
payments only — the same rule as `isActive` on a fee structure.

**3. What is deliberately NOT configurable:** whether a claim can auto-verify. That is a
correctness rule, not a preference, and offering it as a switch invites a school to turn off the
one control that stops a forged screenshot becoming a receipt. A settings screen should not offer
a toggle whose "off" position is a defect.

### Implementation status (2026-08-07) — **shipped, except the online switch**

**Done and live.** *School settings → Fee collection → "We accept"* is a row of chips the owner
toggles; a campus admin sees them read-only. Both rules above hold in the shipped code:
`payments.service` refuses a method the school has not enabled and names the accepted ones in the
error (not a display gate — rule 1), and disabling governs new payments only (rule 2). The UI adds
one guard this section did not call for: **the last enabled method cannot be switched off**, since
a school accepting nothing would have every payment refused by its own setting. `proofPolicy`,
`guardianUploadLink` and `chequeClearingDays` all shipped with it.

**Not done: the `online` block above was never implemented.** The shipped `feeSubmission` group has
`methods`, `proofPolicy`, `guardianUploadLink`, `chequeClearingDays` — there is no
`online: { enabled, provider, companyCode }`, and **`ONLINE` is missing from the `methods` enum**
even though `PaymentMethod.ONLINE` exists in the database and `aggregator.service` writes it.

⚠️ **That gap is correct for now, and adding it early would be a mistake.** An owner who ticked
"Online" today would enable a route that returns **501** — the aggregator refuses to record
anything until a service account exists to attribute a machine-made payment to (§5.3a). That is a
toggle whose *on* position does nothing, which is the same defect as rule 3 in the other direction:
**a settings screen must not offer a switch that cannot do what its label says.**

So the online switch is part of **B6 wiring**, not part of the settings work, and it lands in this
order:
1. merchant agreement signed → company code + sandbox + HMAC secret exist;
2. the per-school **service account** decision is made (§5.3a's blocker);
3. `settle()` writes the `FeePayment`;
4. **then** `ONLINE` joins the `methods` enum and the `online` block appears on the settings
   screen — visible only once a company code is saved, exactly as designed above.

Doing 4 before 1–3 gives a school a button that quietly fails. Doing 1–3 without 4 gives every
school online payments whether they signed up or not. They ship together.

---

## 7. Decisions needed

- **D1 — Which channels for v1?** Recommend **office-entered proof + the guardian SMS link**. The
  office route alone is half a feature (the school still fields WhatsApp screenshots by hand); the
  link is where the labour actually disappears.
- **D2 — Should a claim ever auto-verify?** Recommend **no.** Verification is a human matching a
  reference against a bank statement. Auto-verifying a screenshot is how a school gets defrauded
  by a forged image, and the whole point of the claim/payment split is that money is only real
  once someone confirms it.
- **D3 — Cheques.** A cheque is not money until it clears. Recommend a claim stays `PENDING`
  until the clearing date rather than being verified on receipt — otherwise a bounced cheque has
  already issued a receipt.
- **D4 — One payment covering several children.** Families with three children usually send **one
  transfer**. v1: one claim per invoice, and the clerk splits it. Worth confirming this is
  acceptable — the alternative (a claim spanning invoices) is a bigger change to `pay()`.
- **D5 — Online aggregator:** confirm Kuickpay/1Bill is the intended direction so the PSID field
  is shaped for it, even though nothing is built.
- **D6 — Defaults for a brand-new school.** Recommend `methods: [CASH]`, `proofPolicy: OPTIONAL`,
  `guardianUploadLink: false`, `online.enabled: false` — a new school starts at the simplest
  thing that works and switches on what it grows into. **Demo would be set up with bank transfer
  and the wallets on** so the operator can see the full flow.

---

## 8. Phases

| # | Deliverable | Why this order |
|---|---|---|
| **B0** | **File serving** — presigned GET behind ownership checks | Blocks this, student photos and staff documents. One endpoint, three features |
| **B1** | **`feeSubmission` settings + enforcement** — accepted methods, proof policy, cheque clearing; the School settings section; `pay()` refuses a disabled method | Decides what every screen below even offers, so it comes before them. Ships alone and is useful alone: a cash-only school immediately stops seeing five methods it does not use |
| **B2** | Proof on an office-recorded payment + proof visible on the student profile | Immediate value, no new surface, no security question |
| **B3** | `FeePaymentClaim` + verify/reject + the office queue + dashboard chip | The workflow that makes proof mean something |
| **B4** | ✅ **SHIPPED 2026-08-04.** Tokenised link, public page at `/p/[token]`, rate limits, the PENDING claim it creates — behind `guardianUploadLink`. See §5.2a below. | The labour actually disappears here |
| **B5** | ✅ **SHIPPED 2026-08-04.** `feeReceipt` PDF, `GET /fees/payments/:id/receipt`, payments + receipts on `/me/fees`, receipt offered at the counter the moment it is collected. | What the family asks for |
| **B6** | ✅ **SHIPPED 2026-08-04 as a seam.** `psid` column (unique per school), `ONLINE` method, HMAC webhook that verifies and then **refuses**. See §5.3a. | Ready for the day a merchant account exists |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A forged screenshot is verified | Verification is human and against the bank statement; the claim keeps the image and names the verifier for ever |
| The public upload link is abused | Signed + expiring + rate-limited + ClamAV + type/size capped; reveals only a first name and an amount |
| A claim is verified twice | `transactionRef` partial unique already blocks the duplicate payment; the claim carries `paymentId` so the second attempt is refused with the receipt it already produced |
| Claims pile up unlooked-at | Dashboard chip + queue; the same "a metric that points at a page which cannot act on it is worse than no metric" rule the leave queue followed |
| A cheque bounces after a receipt is issued | D3 — cheques stay pending until the clearing date |
