# Google Calendar Integration — Design (not implemented)

Status: **DESIGN ONLY, AWAITING INDEPENDENT REVIEW.** No schema, migration,
application code, or Google Cloud/OAuth setup has been created. No new
Google permission has been requested. No calendar event has been created.
This document is the full investigation and design report;
`docs/AI-HANDOFF.md` carries a condensed summary and points here.

Goal: when a meeting is scheduled anywhere in FOS — Trip Planning or
donor/Capture scheduling — it can automatically appear on the fundraiser's
own existing primary Google Calendar, one-way (FOS → Google only).

---

## 0. Investigation method

Everything below was confirmed by reading the actual code on
`feature/independent-cloudflare-sandbox` (four parallel read-only
investigations, no edits), not assumed or inferred from naming. Exact
file:line citations are given throughout so a reviewer can verify each
claim directly.

---

## 1. Every scheduling entry point and the canonical meeting identity

**There is one canonical meeting entity, not two.** Both Trip Planning and
plain donor/Capture scheduling write into the same `interactions` table
(`db/schema.ts:107`). **`interactions.id` is the one identifier a Google
Calendar link should key off**, regardless of which UI created the row.

### 1.1 The existing state machine

Scheduling/completion/cancellation state is **not** a dedicated status
column — it lives entirely in a string-prefix convention on
`interactions.source`, centralized in the pure module
`lib/workspace/scheduled-activity.ts`:

- `capture-scheduled:*` — a future meeting, not yet happened.
- `capture:*` / no recognized prefix — an immediately-logged (past) entry.
- `capture-completed:*` — a scheduled meeting that was marked completed;
  encodes the original planned epoch (`capture-completed:(epoch):...`).
- `cancelled:*` — wraps (prefixes) whatever source string was there before.
  Cancellation always wins when resolving status, even over a prior
  completion.
- `archived:*` — same wrapping mechanism, for past/no-response entries.

### 1.2 Routes that create/transition a meeting

| Action | Route | Mechanism | Idempotent? |
|---|---|---|---|
| Create (Capture) | `POST /api/interactions` (`app/api/interactions/route.ts:38`) | INSERT, fresh `crypto.randomUUID()` | **No** — no dedupe key; a double-click/retry can create two rows today. Pre-existing gap, not introduced by this feature. |
| Edit/reschedule | `PATCH /api/interactions/[id]` (`.../[id]/route.ts:21`) | Single UPDATE on the same row; 409 if already cancelled/archived | Yes — same row every time |
| Cancel / archive | `DELETE /api/interactions/[id]` (`.../[id]/route.ts:112`) | `source = 'cancelled:' \|\| source` (or `archived:`) | Yes — 409 "already inactive" blocks a double-cancel |
| Complete / no-response / cancel / reschedule / reopen / undo | `POST /api/interactions/[id]/outcome` (`.../outcome/route.ts:44`) | Single UPDATE with **compare-and-swap**: `WHERE id=? AND user_id=? AND source=? AND occurred_at=?`; `changes=0` → 409 "updated elsewhere" | Yes — the strongest concurrency guard in the codebase; the natural model for sync-side concurrency too |
| Follow-up interaction (from outcome) | same route, line 118 | Deterministic id `activity-followup-${id}`, `INSERT ... ON CONFLICT DO UPDATE` | Yes |
| Trip meeting schedule/complete | `lib/relationships/trips-data.ts`'s `scheduleProspectMeeting()`/`completeProspectMeeting()` (lines 318, 351) | Writes the **same `interactions` table**, deterministic id `trip-meeting-${prospectId}` (`trip-model.ts:191`), `ON CONFLICT DO UPDATE` | Yes — idempotent by construction |
| Trip meeting cancel | `updateProspectStatus()` (`trips-data.ts:278`) | Wraps the linked interaction's source with `cancelled:` | Yes |

Trip Planning's `trip_prospects.meeting_at` / `meeting_location` /
`linked_interaction_id` (`trips-data.ts:109`) are a **denormalized mirror**
of the real `interactions` row for trip-UI display only —
`linked_interaction_id` is the actual FK. Removing a prospect from a trip
does **not** cancel its linked interaction (deliberate — a trip-list
removal is never an implicit meeting cancellation).

### 1.3 Explicitly out of scope (confirmed, not assumed)

- **`recommendations`/reminders** (`due_at`): internal follow-up nudges
  only. `trip-model.ts:38` is explicit that only `meeting_scheduled`/
  `meeting_completed` ever touch a real interaction — every other status,
  including "Planned outreach" (`not_contacted`) and `meeting_requested`,
  **must never fabricate a donor touch**. This directly satisfies the
  requirement that plain "Planned outreach," adding a trip prospect, and
  meeting-requested statuses must never create a calendar event: they
  never create or touch an `interactions` row at all, so there is nothing
  for the sync layer to ever see.
- **`agenda_send_log`** / the daily email: unrelated, no scheduling
  concept.
- **Group/shared activities** (`shared_activities`, multiple donors on one
  logged entry): technically also funnels into `interactions`, but
  recommended **out of v1 scope** (see §7) — a "broadcast to many donors"
  has no clean single-event calendar semantics, and attendee invitations
  are explicitly excluded from this feature anyway.

### 1.4 Location data

Trip meetings already carry a free-text `meeting_location`
(`trip-model.ts:234`, validated, ≤300 chars) on `trip_prospects` — not
copied into `interactions.summary`. **Plain Capture/outcome-route
meetings have no location field anywhere in the schema today.** Donor
mailing address exists on `donors` and is already read elsewhere
(`meeting-brief.ts`'s `DonorRow`), but is **not** recommended as an
automatic calendar-event location (see §7, owner decision).

---

## 2. Proposed user flow and account/calendar setup

1. **One-time setup (owner, outside the app, in a browser)** — mirrors the
   existing, already-reviewed Gmail OAuth precedent exactly (see §3):
   the owner authorizes a Google OAuth client against **their own real
   Google account**, choosing the account during that authorization step.
   This *is* "confirming the exact connected account" — the same
   semantics already relied on for Gmail (sender = the account that was
   authorized, never ambiguous).
2. **Settings → Calendar sync** (new section, modeled on the existing
   `support-card` pattern in `app/settings/SettingsExperience.tsx`):
   - Shows connection state: *Not connected* / *Connected — syncing to
     your primary Google Calendar as `<the email the owner entered when
     they set this up>`*. This label is a plain, owner-confirmed value
     entered once at setup time, not a live API lookup (see §3.3 for why).
   - Shows the default meeting duration (editable).
   - Shows a plain-language disclosure: *"Events created here can be
     edited or deleted directly in Google Calendar, but those changes
     will not update Fundraising OS. Fundraising OS only manages events
     it creates."*
   - A "Disconnect" action (clears the owner-visible label; does **not**
     delete previously-synced events).
3. **Scheduling a meeting** (Capture or Trip Planning, unchanged UI flow
   otherwise): after the `interactions` row is saved, a calendar sync
   attempt is kicked off automatically, with a per-meeting status badge
   (**Pending** / **Synced** / **Failed — Retry**) shown wherever that
   meeting already appears (donor timeline, trip prospect row). A
   **"View on Google Calendar"** link appears once synced, using the
   real event's returned `htmlLink` — this doubles as the most concrete,
   ongoing confirmation of which account/calendar is receiving events.
4. **Reschedule** updates the same linked event in place. **Cancel**
   deletes only that linked event. **Complete** does not touch the
   calendar event at all — it remains as history.

---

## 3. Schema, OAuth, permissions, and credential storage

### 3.1 Why a parallel OAuth grant, never touching Gmail

The existing Gmail integration (`docs/AI-HANDOFF.md`, "Daily Fundraising
Agenda" section) is a **single, shared, app-wide credential** — not
per-user — read as three Worker secrets
(`GMAIL_OAUTH_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN`) in
`lib/agenda/gmail-client.ts:52`, scoped to exactly
`https://www.googleapis.com/auth/gmail.send`. There is no per-user OAuth
token table anywhere in the schema (`users` has no token columns —
`db/schema.ts:9`), consistent with FOS's confirmed single-owner-per-
deployment model (`STAGING_OWNER_EMAIL` / Cloudflare Access scoping to
one email).

This repo's own prior investigation explicitly recorded that any future
Google integration must use **structurally separate** credentials, never
reuse `gmail.send`'s client/token. This design follows that precedent to
the letter: **three new, independently-named secrets**,
`GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`,
`GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN`, set via `wrangler secret put`
exactly like Gmail's, per environment. Gmail's existing client, token,
and `gmail.send` scope are never touched, widened, or re-authorized by
this work.

### 3.2 Recommended scope: the narrowest that can do the job

`https://www.googleapis.com/auth/calendar.events` — grants create/read/
update/delete on **events** on calendars the authorized account already
has access to. **Deliberately not** the broader
`https://www.googleapis.com/auth/calendar` scope, which additionally
grants calendar-list/settings/sharing management that this feature never
needs, since the destination is always the owner's own existing primary
calendar (see §3.4) — never a calendar FOS creates, shares, or deletes.

**One open verification item, not a blocker**: confirm at Google Cloud
Console setup time (before writing code) that `calendar.events` alone is
sufficient for (a) supplying a caller-chosen event `id` on insert — the
mechanism this design uses for duplicate-prevention, see §4.1 — and (b)
reading back an inserted event's own `htmlLink`/`summary` for the "View
on Google Calendar" link. Both are standard, long-documented Calendar API
v3 behaviors under `calendar.events`, but should be confirmed against
current Google documentation at implementation time rather than assumed
here from training knowledge.

App type: **Internal** (same Google Workspace org as Gmail's, already
confirmed real — `nirc.edu`), for the same reason already proven for
Gmail: avoids the Testing-mode 7-day refresh-token-expiry trap that an
External app would carry.

### 3.3 Why no in-app OAuth redirect/callback flow

FOS has **no existing "Connect your Google account" UI anywhere** — Gmail
was authorized entirely out-of-band (the owner, manually, once, in a
browser, via Google's OAuth Playground or equivalent), per
`docs/AI-HANDOFF.md`'s own record of that rollout. Building a full
interactive OAuth authorization-code redirect/callback flow inside FOS
would be new surface area (a new public-ish callback route, state/CSRF
handling, token exchange code) for a single-owner app that only ever
needs to do this once. This design recommends **reusing the exact
lower-risk, already-reviewed Gmail pattern**: the owner performs the
one-time authorization manually, outside the app, and simply tells FOS
(by setting the three secrets, and typing their own email into the new
Settings field as a confirmation label) that it's done. Settings never
performs a live "who am I" API call — it displays what the owner
confirmed at setup time, plus the real `htmlLink` from the first synced
event as organic, ongoing proof.

*(If, after reviewing this, the owner would actually prefer a real in-app
"Connect" button with a redirect flow, that is a deliberate scope
expansion to flag explicitly before coding — not assumed here.)*

### 3.4 Destination calendar: "primary," no calendar-listing call needed

The owner wants sync to their existing primary work calendar, not a new
FOS-created one. Google Calendar's API has a reserved literal calendar id,
`"primary"`, that always resolves to the authorized account's own primary
calendar — **no `calendarList.list` call, and no broader `calendar`/
`calendar.calendarlist` scope, is needed** to address it. Settings stores
`google_calendar_id` defaulting to the literal `"primary"`, with an
optional advanced free-text override field for a specific secondary
calendar ID, should the owner ever want one later — still requiring no
new scope.

### 3.5 Schema changes (new migration `0048_google_calendar_sync.sql`)

**New table**, one link row per synced meeting:

```sql
CREATE TABLE calendar_event_links (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  google_calendar_id TEXT NOT NULL DEFAULT 'primary',
  google_event_id TEXT,              -- NULL until a create attempt succeeds
  status TEXT NOT NULL CHECK (status IN ('pending','synced','failed')) DEFAULT 'pending',
  last_error TEXT,                   -- HTTP status/class only, never a raw response body (mirrors gmail-client.ts's own discipline)
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX calendar_event_links_interaction_uidx ON calendar_event_links (interaction_id);
CREATE INDEX calendar_event_links_status_idx ON calendar_event_links (status);
```

The `UNIQUE` index on `interaction_id` is the real backstop (same
"app-level check + DB constraint as the actual guarantee" philosophy as
`trip_prospects`' own `UNIQUE(trip_id, donor_id)`) — at most one calendar
link can ever exist per meeting, structurally, not just by convention.

**New nullable columns on `interactions`** (additive, non-breaking):

- `all_day INTEGER NOT NULL DEFAULT 0` — true only for a genuinely
  date-only *live-scheduled* meeting. **Deliberately a new column, never
  reusing `occurredAtDateOnly`**: that existing column's only current
  meaning, confirmed by reading every writer, is "Monday.com historical
  import, time unknown" (`app/api/import/monday/commit/route.ts`) —
  conflating it with a newly-introduced live "schedule with no time"
  concept would silently change the meaning of historical data nobody
  asked to change. `all_day` is never set true by the import path.
- `end_at INTEGER` — nullable end instant for a *timed* meeting (NULL for
  an all-day meeting, where it's meaningless). Stored explicitly once a
  duration is confirmed, never silently defaulted and hidden — see §5.2.
- `location TEXT` — nullable, explicit, user-entered. Never auto-filled
  from the donor's mailing address (see §7, owner decision — a donor's
  home address appearing on a calendar event the owner might view on
  their phone or share is more sensitive than the owner actively typing
  an address they chose).

No existing column, index, or table is altered. `occurredAt` keeps its
current meaning (a true Unix instant for every live meeting, confirmed in
§5) for both all-day and timed meetings — for an all-day meeting it's the
start-of-day instant in the fundraiser's/trip's own timezone, converted
once via the existing `zonedTimeToUtc()` (§5.1), never UTC midnight.

---

## 4. Create / update / cancel / retry behavior and duplicate prevention

### 4.1 Duplicate prevention — client-assigned event ID as the primary mechanism

Google Calendar's `events.insert` accepts a caller-supplied `id` (subject
to Google's own charset/length constraints — to be confirmed exactly at
implementation time per §3.2). This design derives that id deterministically
from `interactions.id` (e.g. a stable hash into Google's allowed
character set) and always sends it on insert. Consequences:

- A retried insert after an **ambiguous timeout** (we don't know if the
  first attempt succeeded) is safe: Google returns `409 Already Exists`
  for the second attempt with the same id, which the sync code treats as
  "already created" and resolves by doing a GET to confirm, rather than
  creating a second event.
- A **double-click/retry** at the FOS layer resolves the same way, one
  level up: `calendar_event_links`' `UNIQUE(interaction_id)` means a
  second sync attempt for the same meeting always finds (and reuses) the
  existing link row rather than racing a second INSERT.

### 4.2 Sync flow

1. After an `interactions` row is saved (create or reschedule) with
   `all_day` or a future `occurredAt`, enqueue a sync attempt. **The
   interaction save itself never waits on or is rolled back by the
   calendar call** — satisfying "a Google failure must not lose the saved
   FOS meeting" directly, by construction (two separate writes, the FOS
   one always first and unconditional).
2. SELECT the existing `calendar_event_links` row for this
   `interaction_id`.
   - **Found, `status='synced'`, has a `google_event_id`**: this is a
     reschedule → call `events.patch` on that id. Update the link row's
     `updated_at` with an optimistic-concurrency check
     (`WHERE id=? AND updated_at=?`, mirroring the existing CAS pattern in
     `app/api/giving/[id]/route.ts`) so a stale, slow retry can never
     clobber a newer sync's result.
   - **Found, `status='pending'` or `'failed'`**: retry create (idempotent
     via §4.1).
   - **Not found**: INSERT a new `status='pending'` row first (the
     `UNIQUE` index is the real race backstop), then attempt create.
3. On success: UPDATE the link row to `status='synced'`, store
   `google_event_id`, clear `last_error`.
4. On failure (any non-2xx, network error, or timeout): UPDATE to
   `status='failed'`, store a status-code/class-only `last_error` (never
   the raw response body — mirrors `gmail-client.ts`'s own leak-prevention
   discipline), increment `attempt_count`. The FOS meeting itself is
   completely unaffected. The UI's **Retry** action simply re-runs step 2.
5. **Cancel**: if a link row has a `google_event_id`, call
   `events.delete` for that id only, then mark the link row
   `status='failed'`→ actually delete the link row (or a dedicated
   `cancelled` marker — open implementation detail, not a design
   blocker) so a later re-schedule of the same interaction id (rare, but
   possible via "reopen") creates a fresh event rather than reusing a
   deleted one's stale id.
6. **Complete**: no calendar call at all. The event is left exactly as
   it is — satisfying "marking a meeting completed retains its calendar
   history" by simply never touching it.

### 4.3 Concurrent edits and disconnect/reconnect

- Two near-simultaneous reschedules of the same meeting: the second
  `PATCH /api/interactions/[id]` wins at the FOS layer (already
  guarded — §1.2); its sync attempt's optimistic-concurrency check (§4.2
  step 2) ensures the calendar event converges to match the FOS row that
  actually won, never an interleaved/stale result.
- **Disconnect** (owner clears the secrets): sync attempts for any new
  or rescheduled meeting simply find no credential and leave the link row
  `pending`/`failed` — no error surfaced beyond the normal Failed/Retry
  state. **Nothing deletes previously-synced events.**
- **Reconnect**: new secrets are set; the next scheduling action syncs
  normally. **No automatic backfill** of meetings that stayed
  pending/failed during the disconnected window — per the explicit
  instruction, backfilling existing/missed meetings is a separate,
  explicit action the owner would trigger deliberately (e.g. a "Retry
  all failed" button), never automatic.

---

## 5. Date-only, duration, timezone, and existing-meeting compatibility

### 5.1 Reuse the existing, already-correct timezone pipeline — do not reinvent it

Confirmed by reading `lib/relationships/trip-model.ts:95-145` and
`lib/workspace/local-time.ts` in full: Trip Planning's meeting scheduling
already has a real, DST-safe, independently-reviewed pipeline —
`parseLocalDateTimeInput()` (strict regex, never `new Date()`, so the
browser's own timezone never leaks in) → `timezoneForState()` (the
destination region's IANA zone, falling back to the fundraiser's own
`profile.timezone`) → `zonedTimeToUtc()` (wall-clock → true UTC instant,
checked twice to self-correct across a DST boundary). **This design reuses
that exact pipeline for every timed meeting, Trip Planning or Capture,
unchanged** — Capture meetings simply use the fundraiser's own
`profile.timezone` directly (no destination region to resolve).

Confirmed separately: `interactions.occurredAt` for any live
scheduled/completed meeting is already a **true Unix instant** (not the
UTC-midnight-anchored "date-only epoch" convention used for recurring
family dates) — it converts to a Google Calendar timed event (`start.
dateTime` / `end.dateTime`, each with an explicit IANA `timeZone` field)
with no new conversion logic needed.

### 5.2 Date-only (all-day) meetings — a genuinely new capability

Confirmed: **no live, user-facing path creates a date-only meeting
today.** Capture's single `<input type="datetime-local">` (there is no
separate date-only picker) and Trip Planning's scheduling both always
require a full date+time. Supporting "a date, no time" is new UI, not
reuse of `occurredAtDateOnly` (§3.5 explains why that column is the wrong
vehicle). The new `all_day` flag plus a date-only input is proposed for
both Capture and the trip-meeting scheduling form, for the same reason
both already share one backend function.

For Google Calendar's all-day event shape specifically: Google's
`start.date`/`end.date` fields use **inclusive start, exclusive end** —
a one-day all-day event spanning just "March 5" is `start.date:
2026-03-05, end.date: 2026-03-06` (the day *after* the last day). This
design computes that `end.date` via the existing `addCalendarDays()`
helper (`lib/workspace/local-time.ts` — already UTC-anchored calendar-day
arithmetic, explicitly DST-immune per its own doc comment) applied to the
meeting's stored date, never by adding `86400` seconds to an epoch (which
would be wrong across a DST transition for a timed value, though moot
here since all-day events carry no time-of-day at all).

**Never inferred**: a meeting with no date is never synced, and a
date-only meeting is never represented as midnight in FOS's own data —
`all_day=1` with a real calendar date is the stored fact; Google's exact
`date`-vs-`dateTime`/exclusive-end encoding is purely an output-shaping
concern at sync time, confined to the sync layer.

### 5.3 Duration / end time for timed meetings

No duration concept exists anywhere in the schema today. This design adds
`interactions.end_at` (§3.5), populated from a **visible, editable
default duration** shown in the UI at scheduling time (default value is
an explicit owner decision — see §7) — never silently defaulted and
hidden. `end_at` is required before a timed meeting can sync (a meeting
missing an end time is treated the same as a meeting missing a required
date: held back from sync, not guessed).

### 5.4 Existing-meeting compatibility

Every `interactions` row that exists today already has `all_day=0`
(column default) and `end_at=NULL` after this migration — i.e., every
pre-existing meeting is represented, correctly, as "timed, no known end
time yet." **No backfill sync is triggered by the migration itself** —
`calendar_event_links` starts empty; a pre-existing future-scheduled
meeting only gets synced if the owner takes the explicit "Sync existing
meetings" action discussed in §7, never automatically.

---

## 6. Staging testing, rollout phases, and rollback

### 6.1 Staging must not write to the real Production calendar by default

Two independent layers, mirroring the exact pattern already proven
necessary for Gmail (a 2026-10-14 incident showed that a Cloudflare
config change alone — `wrangler.staging.jsonc`'s empty `triggers.crons`
— was *not* sufficient to stop a real send from Staging; the fix was a
fail-closed check inside the application code itself,
`lib/agenda/email-send-guard.ts`):

1. **Separate credentials per environment, by default absent on
   Staging.** `GOOGLE_CALENDAR_OAUTH_*` secrets are set independently on
   Production and Staging via `wrangler secret put --config
   wrangler.{env}.jsonc`. Recommended default: **Staging has no calendar
   secrets configured at all** — sync silently shows "Not connected,"
   nothing errors. If the owner later wants to test end-to-end on
   Staging, the one-time authorization step is performed again against a
   **disposable/test Google Calendar**, never the real primary one.
2. **A call-site environment guard**, a new `lib/calendar/
   calendar-sync-guard.ts` modeled directly on `email-send-guard.ts`:
   even if Staging's secrets were ever accidentally copied from
   Production (human error), the guard refuses to call the real Calendar
   API unless `deploymentEnvironment === "production-independent"`
   **or** a separate, explicit Staging opt-in var is set. This makes
   "Staging cannot write to the real calendar" true in application code,
   independent of which secrets happen to be configured — the same
   defense-in-depth property the Gmail incident proved necessary.

Because Production and Staging are already fully separate D1 databases
(`fundraising-os-production-db` / `fundraising-os-staging-db`),
`calendar_event_links` rows are automatically isolated too — no
environment column is needed on the table itself.

### 6.2 Rollout phases

1. **This design, reviewed and approved** (current phase).
2. **Migration `0048`** (additive only — new table, three new nullable
   columns) — built with its own fresh/upgrade schema test, same pattern
   as `0047`'s — deployed to Staging first through the established
   workflow.
3. **Sync backend** (pure logic + D1-integrated loader, split the same
   way `lib/agenda/` already splits pure-vs-impure modules for
   testability) — deployed to Staging with the guard from §6.1 active and
   no real secrets configured (fully inert), covered by unit tests for
   the create/update/cancel/retry/duplicate-prevention logic against a
   mocked Calendar API.
4. **Owner performs the one-time OAuth authorization against a
   disposable test calendar**, sets Staging secrets, verifies end-to-end
   on Staging: create, reschedule-updates-same-event, cancel-removes-
   only-that-event, complete-retains-history, a forced-failure retry, and
   an all-day meeting's exclusive end-date. No donor data beyond what
   Staging already has is needed — no new test donors/meetings required
   beyond what's naturally exercised by using the feature once.
5. **Owner reviews Staging verification and explicitly approves
   Production** — a separate, deliberate decision point, not implied by
   Staging working.
6. **Owner performs a second, separate one-time OAuth authorization**,
   this time against their real primary work calendar; Production
   secrets set via `wrangler secret put --config
   wrangler.production.jsonc`.
7. **Deploy to Production**; verify against the real calendar using the
   owner's own next real scheduled meeting (or a meeting the owner
   schedules and then immediately cancels themselves) — never a
   fabricated test donor/interaction, consistent with this repo's
   existing no-test-data-on-Production discipline.

### 6.3 Rollback

A Worker-code rollback (`wrangler rollback <version>`) if a regression
occurs — reverts only the deployed code, never touches D1. Per this
repo's own established rollback philosophy (restated explicitly because
it governs this feature too): **the additive migration and all
`calendar_event_links`/`interactions` data are always retained** — never
drop the new columns/table, never reverse a sync, as a rollback shortcut.
Disconnecting (clearing the three secrets) is the correct, immediate way
to stop all future syncing without any schema change — previously-synced
Google events and all FOS meeting data are completely unaffected either
way.

---

## 7. Exact owner decisions required before implementation

1. **Default meeting duration** for a timed event (e.g. 30 or 60
   minutes) — shown and editable at scheduling time, but needs a starting
   value.
2. **Meeting location field**: add an explicit, user-typed `location` to
   Capture (Trip Planning already has one) — confirm whether to ever
   offer the donor's mailing address as a one-click fill-in, or keep it
   fully manual/opt-in as recommended in §3.5 (recommended: manual only,
   for privacy — a donor's home address should never appear on a
   calendar event without the owner actively choosing to put it there).
3. **Group/shared activities**: confirmed out of v1 scope (§1.3) —
   please confirm this is acceptable, or flag if multi-donor calendar
   sync is actually wanted later.
4. **All-day support in Trip Planning specifically**: recommended for
   consistency with Capture, but trip meetings have historically always
   been timed — confirm this is wanted, not just Capture.
5. **Staging test calendar**: confirm the owner will set up a disposable
   Google Calendar for Staging verification (§6.1) rather than leaving
   Staging permanently disconnected until Production rollout (also an
   acceptable, simpler choice — would mean Staging-only logic is unit-
   tested but never live-verified against a real Google Calendar before
   Production).
6. **"Sync existing meetings" backfill action**: confirm whether a
   deliberate, explicit, owner-triggered "sync my already-scheduled
   meetings" button is wanted at all post-launch (never automatic, per
   instruction) — or whether new-meetings-only is sufficient indefinitely.
7. **Exact Google Calendar API scope/event-ID-format verification**
   (§3.2) — not an owner decision as such, but needs a quick confirmation
   against current Google documentation before coding starts, since this
   design's duplicate-prevention mechanism (§4.1) depends on it.

No hard blocker was found that would prevent building this feature as
scoped — the items above are owner decisions and one documentation
double-check, not architectural obstacles.
