# Feature #2 — WhatsApp Integration (Design Spec)

> **Status:** Design DRAFT (2026-07-19). Release 1. Depends on #1 for the parent-facing payoff.
> **Goal:** Deliver school→parent notifications (absence alert, fee reminder, result-ready) over
> WhatsApp in addition to SMS, plugging into the existing comms pipeline rather than a parallel one.

## Open Decisions (confirm before build)

1. **Provider / BSP.** WhatsApp Business Platform requires a provider. Options:
   - **(a) Meta Cloud API direct** — cheapest at scale, you own the WABA, more setup (Meta Business
     verification, phone number, template approval). **Recommended** for a product sold to many schools.
   - **(b) BSP (360dialog / Twilio / Interakt)** — faster onboarding, higher per-message cost, less
     compliance burden. Good for the pilot; can migrate later behind the channel abstraction.
   - **Recommendation:** build against the **channel abstraction** so the provider is swappable; start
     the pilot on a BSP (fast), plan Meta-direct for scale. **⚠️ Product owner picks the pilot provider.**
2. **Which notifications go to WhatsApp in v1?** Recommendation: **absence alert, fee reminder,
   result-ready**. **OTP stays on SMS** in v1 (WhatsApp OTP needs an authentication-category template
   + tighter latency SLAs — keep the login path simple and proven). ⚠️ Confirm.
3. **Per-school WABA vs shared sender.** Recommendation: **one shared platform WABA** (your brand) with
   the school name in the message body, for v1 — per-school sender numbers are an ops burden. ⚠️ Confirm.
4. **Consent model.** WhatsApp requires opt-in. Recommendation: reuse the parent contact + an explicit
   `whatsappOptIn` flag; default parents to opted-in for **transactional** school messages captured at
   admission, with opt-out honored. ⚠️ Confirm this matches how the schools collect consent.

## 1. Business Analysis

- **Problem:** SMS is dying in Pakistan (deliverability, cost, spam filters). WhatsApp is where parents
  actually read messages. Absence alerts and fee reminders on WhatsApp dramatically lift open/response
  rates — and fee reminders drive the defaulter-recovery number that sells the whole product.
- **Why now:** the comms module already has templates, credit ledger, segment math, a gateway
  abstraction, and BullMQ dispatch — WhatsApp is a **new channel behind an existing pipeline**, not a
  new subsystem.
- **Existing foundation:** `apps/api/src/modules/comms/sms/` — `sms-gateway.ts` (abstraction),
  `sms-producer.service.ts`, `sms-queue.provider.ts`, `credits.service.ts`, `SmsTemplate`
  (`triggerKey`: FEE_REMINDER | FEE_RECEIPT | ABSENCE | RESULT_READY | LEAVE_STATUS | ACCOUNT_INVITE |
  MANUAL), `SmsLog`, `SmsCreditLedger`.

## 2. Users & Roles

| Role | Interaction |
|---|---|
| System (event-driven) | Sends absence/fee/result templates automatically. |
| OWNER_ADMIN / CAMPUS_ADMIN | Configure templates, view delivery logs, manage credits/opt-out. |
| ACCOUNTANT | Fee-reminder templates + logs (fee-related only). |
| PARENT | Receives messages; can opt out. |

## 3. Architecture — Channel Abstraction

Generalize the SMS pipeline into a **multi-channel notification** pipeline. Minimal-churn approach:

```
NotificationRequest { triggerKey, recipient, channel: SMS|WHATSAPP, params, refIds }
        │
        ▼
  ChannelRouter ── picks provider by channel + school config + consent + fallback policy
        │
   ┌────┴─────────────┐
   ▼                  ▼
SmsGateway       WhatsAppGateway   ← both implement the same MessageGateway interface
(existing)       (new)
   │                  │
   ▼                  ▼
  SmsLog          MessageLog (extend SmsLog → generic, or add channel column)
```

- **Extend `sms-gateway.ts`'s interface** into a `MessageGateway` contract
  (`send(msg): {gatewayMessageId}`) and add `whatsapp-gateway.ts` implementing it against the chosen
  provider's HTTP API.
- **Fallback policy:** if WhatsApp fails (undeliverable / not opted-in / no WA account on number),
  auto-fall back to SMS for the same message (configurable per trigger). Log both attempts.
- **Webhooks:** WhatsApp delivery/read receipts arrive via a provider webhook → update the log row
  (`deliveredAt`, read status). Reuse the existing HMAC-verified `SmsWebhookController` pattern for a
  new `WhatsAppWebhookController`.

## 4. Data Model

Prefer **generalizing** the existing SMS models over duplicating them:

- `SmsLog` → add `channel Channel @default(SMS)` (enum `SMS | WHATSAPP`) and rename mentally to
  "message log" (keep table name for migration safety, or introduce `MessageLog` and migrate).
  Add `readAt DateTime?` for WhatsApp read receipts.
- `SmsTemplate` → add `channel` (or a companion `WhatsAppTemplate` holding the **Meta-approved template
  name + language + variable mapping**, since WA templates are pre-registered artifacts, not free text).
  ⚠️ WhatsApp template bodies are **approved by Meta/BSP**, not editable free-form like SMS — the schema
  must store the provider template id/name, not just body text.
- `SmsCreditLedger` → either a separate WhatsApp credit ledger or a `channel` dimension; WhatsApp is
  priced per **conversation** (24h window), not per segment — **costing differs**, so keep channel-tagged
  ledger entries. ⚠️ Confirm billing model to the schools (per-message vs bundled in plan).
- `ParentProfile` / contact → add `whatsappOptIn Boolean @default(...)` and `whatsappNumber` if it can
  differ from `phone`.

## 5. API Surface

Extend `comms.controller.ts` (do **not** create a parallel controller):

| Method + Path | Purpose | Guard (fix audit gap!) |
|---|---|---|
| `GET /comms/channels` | available channels + per-school config/status | OWNER_ADMIN / CAMPUS_ADMIN |
| `GET/PUT /comms/whatsapp/templates` | map trigger → approved WA template | OWNER_ADMIN / CAMPUS_ADMIN |
| `POST /comms/whatsapp/send` | manual/test send | OWNER_ADMIN / CAMPUS_ADMIN |
| `GET /comms/logs?channel=whatsapp` | delivery logs (⚠️ **add `@Roles`** — currently unguarded) | OWNER_ADMIN / CAMPUS_ADMIN / ACCOUNTANT(fee) |
| `POST /webhooks/whatsapp` | provider delivery/read receipts (HMAC-verified) | public + signature |

## 6. UI

Folds into the **SMS/Comms Center** built in feature #4 — add a channel toggle (SMS / WhatsApp), a
WhatsApp template mapping screen (read-only bodies + variable preview since Meta owns the body), and a
per-channel delivery log filter. No standalone screen.

## 7. Edge Cases

| Case | Behavior |
|---|---|
| Number has no WhatsApp | Delivery fails → SMS fallback (if policy allows) → log both. |
| Parent opted out of WhatsApp | Skip WA → SMS fallback or suppress per trigger policy. |
| WhatsApp 24h session window closed | Only template (HSM) messages allowed; free-form blocked — all school→parent sends are templates anyway. |
| Template not yet approved by Meta | Send blocked with a clear admin error; do not silently drop. |
| Provider outage | Queue retries with backoff (BullMQ); fall back to SMS after N retries. |
| Duplicate event (e.g. absence re-marked) | Idempotency key per (trigger, refId, date) — reuse the SMS dedup discipline. |
| Cost spike | Credit ledger guard: block/queue sends when balance exhausted, alert admin. |
| Multiple guardians | Send to `isPrimary` only (same rule as SMS) unless school configures both. |

## 8. Testing Checklist

- Gateway contract test: SMS and WhatsApp both satisfy `MessageGateway`.
- Fallback: WA-fail → SMS attempt, both logged.
- Webhook: HMAC verification, delivery + read status updates, replay-safe.
- Consent: opt-out suppresses correctly per trigger.
- Idempotency: duplicate event does not double-send.
- Credit ledger debits per channel with correct cost model.
- **Security:** `/comms/logs` and template/credit endpoints now `@Roles`-guarded — add matrix rows
  (closes the audit's unguarded-SMS-endpoints finding).

## 9. Scalability

- Channel abstraction keeps provider swappable (BSP → Meta-direct) with no caller changes.
- BullMQ handles burst (whole-school fee reminder run) with rate-limited workers respecting provider TPS.
- Per-conversation costing tracked in the ledger for accurate per-school billing at scale.

## 10. Build Order

1. Generalize `MessageGateway` interface from `sms-gateway.ts`; add `channel` to logs/templates/ledger.
2. Implement `whatsapp-gateway.ts` against the chosen provider + `ChannelRouter` with fallback policy.
3. `WhatsAppWebhookController` (HMAC) for delivery/read receipts.
4. Wire existing triggers (absence, fee reminder, result-ready) to route via WhatsApp when enabled.
5. Add/guard comms endpoints; consent flags.
6. UI folds into feature #4's comms center.
7. Tests + brain update (Key Decisions: provider choice, consent model, costing).
