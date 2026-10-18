# Google Calendar Integration — Design (not implemented)

Status: **DESIGN REVISION, AWAITING INDEPENDENT RE-REVIEW.** No schema,
migration, application code, or Google Cloud/OAuth setup has been
created. No new Google permission has been requested. No calendar event
has been created. This document is the full investigation and design
report; `docs/AI-HANDOFF.md` carries a condensed summary and points here.

Goal: when a meeting is scheduled anywhere in FOS — Trip Planning or
donor/Capture scheduling — it can automatically appear on
**sgoldstein@nirc.edu's existing primary Google Calendar**, one-way (FOS
→ Google only). Calendar credentials remain structurally separate from
Gmail's.

## Revision note (this pass)

Independent review found the first draft's concurrency, duplicate-
prevention, cancellation/reopening, and account-verification design were
not concrete enough to implement safely, and that §3.5/§5.2 contradicted
each other on all-day storage. This revision replaces those sections with
a concrete mechanism for each, verified against current official Google
Calendar API documentation (cited inline), and adds failure-scenario
acceptance tests, an implementation sequence, and a separate Google-setup
checklist. Every reviewer-raised issue is addressed under its own
numbered heading below, cross-referenced to the issue number from the
review. Owner-question items from the first draft have mostly been
converted into firm recommendations, per instruction; only genuinely
irreducible choices remain as questions (§11).

---

## 1. Every scheduling entry point and the canonical meeting identity

*(Unchanged from the reviewed draft — not challenged. Restated briefly;
see the prior revision's full citations, still accurate.)*

**One canonical meeting entity, not two.** Both Trip Planning
(`lib/relationships/trips-data.ts`'s `scheduleProspectMeeting()`/
`completeProspectMeeting()`, deterministic id `trip-meeting-
${prospectId}`) and plain Capture (`POST /api/interactions`) write into
the **same `interactions` table** (`db/schema.ts:107`).
**`interactions.id` is the one identifier a calendar link keys off.**

State lives in an `interactions.source` string-prefix convention
(`capture-scheduled:`/`capture-completed:`/`cancelled:`/`archived:`,
centralized in `lib/workspace/scheduled-activity.ts`), transitioned via
`PATCH/DELETE /api/interactions/[id]` and the compare-and-swap
`POST /api/interactions/[id]/outcome` (`WHERE id=? AND user_id=? AND
source=? AND occurred_at=?`, 409 on mismatch). Trip meetings funnel into
the same table via the same deterministic-id-upsert idiom.

**Confirmed structurally out of scope**: reminders/recommendations
(`due_at`) never touch `interactions` for any status except
`meeting_scheduled`/`meeting_completed` (`trip-model.ts:38`) — "Planned
outreach," adding a trip prospect, and `meeting_requested` have nothing
for a sync layer to ever see, by construction. Group/shared activities
(`shared_activities`) are explicitly out of v1 scope (§10, firm
recommendation, not a question this time).

**Location**: Trip meetings carry `trip_prospects.meeting_location`
(free text, ≤300 chars). Plain Capture/outcome-route meetings have no
location field today — this design adds one (§3.5, §10).

---

## 2. Proposed user flow

1. **One-time setup (owner, outside the app)**: the owner authorizes a
   new, separate Google OAuth client against their real
   `sgoldstein@nirc.edu` Google account — same manual, out-of-band
   pattern already reviewed and used for Gmail (§4.3). FOS does **not**
   trust that this account was chosen correctly merely because the owner
   says so (Issue 4) — see §5 for how it's verified through Google
   itself, every time, not just once.
2. **Settings → Calendar sync**: connection status is **computed from a
   live, cheap Google identity check**, not a typed label (§5). Shows:
   *Connected — syncing to `sgoldstein@nirc.edu`'s primary calendar* /
   *Not connected* / *Connected, but wrong account — sync disabled*
   (§5.3). A persisted **Sync enabled** toggle (§5.4) — separate from
   whether credentials exist — that actually gates every Calendar API
   call. A default-duration field. The one-way-sync disclosure
   (unchanged from the prior draft). A **Disconnect** action that flips
   the persisted toggle off (§5.4) — not just a display change.
3. **Scheduling a meeting** (Capture or Trip Planning): the
   `interactions` write and the "this meeting needs a calendar sync"
   intent are recorded **in the same atomic write** (§3), so the intent
   survives even if nothing calls Google yet. A status badge (**Pending
   / Synced / Failed — Retry / Removed from your calendar**, the last
   one new — see §7.4) appears wherever the meeting is shown. A **View on
   Google Calendar** link appears once synced.
4. Reschedule updates the same linked event. Cancel removes only that
   event. Complete never touches the calendar event.

---

## 3. Issue 1 — Request idempotency at meeting creation

**Problem confirmed exactly as raised**: `POST /api/interactions`
(`app/api/interactions/route.ts:38`) generates `crypto.randomUUID()`
**server-side**, so a network retry or a double-click sends two
requests, each getting its own id, each INSERTed — two real
`interactions` rows. A `UNIQUE(interaction_id)` constraint on
`calendar_event_links` cannot fix this: there are genuinely two
different, valid interaction ids, so each gets its own correctly-synced
Google event. Two FOS meetings, two calendar events. The fix has to be
at the interaction-creation layer, not the calendar layer.

**Fix: move id generation to the client, reuse the codebase's own
existing idempotent-upsert idiom.** This is not a new pattern — it is
the exact mechanism already used for trip meetings
(`trip-meeting-${prospectId}`) and the outcome route's follow-up
interaction (`activity-followup-${id}`), both `INSERT ... ON CONFLICT
(id) DO ...`. Applying it to plain Capture:

1. The Capture UI generates one `crypto.randomUUID()` **once**, when the
   form is opened/first rendered — not regenerated on resubmission,
   retry, or double-click. It is submitted as the interaction's own
   `id` (a new, optional request field; omitted callers keep getting a
   server-generated id, for backward compatibility with any other
   future caller that doesn't yet send one).
2. The route becomes `INSERT INTO interactions (id, ...) VALUES (?, ...)
   ON CONFLICT(id) DO NOTHING`, then always `SELECT`s and returns the
   row by that id — regardless of whether *this* call's INSERT won or a
   prior retry's did. The caller cannot tell, and does not need to:
   it always gets back the one canonical row.
3. The submit button is also disabled while a request is in flight (a
   normal, independent first line of defense) — but correctness does not
   depend on that; it depends on step 1-2 holding even if the UI guard
   fails.

With this fix, "one `interactions` row per meeting, created exactly
once" is true by construction, which is the precondition the original
draft's `calendar_event_links.UNIQUE(interaction_id)` actually needed
and didn't have.

---

## 4. Issue 2 — Durable synchronization and ordering (the core rework)

The reviewed draft's flaw, stated plainly: doing `events.patch` first
and a **local** `WHERE updated_at=?` compare-and-swap *after* it only
protects FOS's own bookkeeping row. It does nothing to stop a slow,
older HTTP request from completing *after* a faster, newer one and
silently overwriting the newer state on Google's own servers — local CAS
cannot order two independent remote calls. This section replaces that
mechanism entirely with one anchored in Google's own concurrency
primitive, plus a durable local work model.

### 4.1 Verified against current Google documentation

- **ETag/If-Match is real and documented**, for **update and delete**
  specifically: "you can specify an `If-Match` header that contains the
  value of the etag from the previous retrieval... Otherwise, you will
  get a 412 (Precondition failed) response code." ([Get specific
  versions of resources](https://developers.google.com/calendar/api/guides/version-resources))
- **`events.patch` does *not* document `If-Match` support** — the
  version-resources guide covers update/delete only, and the
  `events.patch` reference itself doesn't mention etags or conditional
  headers at all; it instead recommends "prefer using a `get` followed
  by an `update`" ([Events: patch](https://developers.google.com/calendar/api/v3/reference/events/patch)).
  **This design therefore uses `events.get` → `events.update` (PUT, full
  replace) with `If-Match`, never `events.patch`**, correcting the
  original draft.
- **`events.insert` has no conditional-modification support** — by
  design: "There is no support for conditional modifications for insert
  operations" (same version-resources guide) — duplicate-prevention on
  create has to come from the caller-supplied id instead (§6), not from
  etags.
- **Custom event ids**: lowercase base32hex characters (`a`–`v`, `0`–`9`),
  length 5–1024, must be unique per calendar; a collision returns `409`
  ("An instance with the given ID already exists... Generate a new ID if
  you want to create a new instance, otherwise use the update method
  call" — [Handle API errors](https://developers.google.com/calendar/api/guides/errors)).
- **Deleted event ids are not reusable** — deleting an event leaves a
  tombstone; re-inserting with the same id fails `409` ("the ID unique
  constraint is violated" — confirmed via a Calendar API client issue
  thread and Google's own 409 guidance above). **This directly validates
  Issue 3's warning** and is designed around explicitly in §7.

### 4.2 Desired-state model, not a patch queue

Replace "apply this one patch" with "reconcile Google to match what
`interactions` says *right now*." `calendar_event_links` gains:

- `desired_state` (`present` | `absent`) — `present` while the meeting
  is actively scheduled; flipped to `absent` the instant a cancel is
  requested.
- `desired_revision` (integer, starts at 1) — bumped by **any** FOS
  write that changes what the event should look like (reschedule, title/
  location edit) or whether it should exist (cancel/reopen).
- `synced_revision` (integer, starts at 0) — the revision last
  **confirmed** reflected on Google.
- `google_etag` — the etag from the last successful `get`/`update` of
  this event, used as the next `If-Match`.

A row "needs reconciliation" whenever `synced_revision < desired_revision`
or `sync_status != 'synced'`. The reconciler **always re-reads the
current `interactions` row** to build the event body — it never replays
a historical payload captured at request time — so it converges to
whatever is true *now*, even if several edits happened before a sync
attempt ever ran.

### 4.3 Durable pending work (crash recovery)

The "this needs to sync" fact is written **in the same D1 batch** as the
`interactions`/`trip_prospects` mutation that caused it (bump
`desired_revision`, flip `desired_state`, etc.) — so the intent is
durable the instant the user's save succeeds, independent of whether any
network call to Google ever runs. Two triggers actually attempt the
work:

1. **Opportunistic**: right after the write, via `ctx.waitUntil()` —
   the same mechanism already used for the agenda cron (`worker/
   index.ts`). Usually completes before the user next looks.
2. **Reconciliation sweep**: a new, dedicated Cron Trigger (recommended
   every 5 minutes — more frequent than the existing hourly agenda cron,
   since "my meeting shows up on my calendar" has tighter latency
   expectations than a daily email; see §10 for the exact wrangler
   change) scans for any row needing reconciliation and processes it.
   This is what survives a Worker crash mid-`waitUntil()`, a Cloudflare
   edge case, or the owner being offline when a meeting was scheduled —
   bounded by the sweep interval, never lost.

Both triggers call the **same** reconcile function, gated by the **same**
lease (§4.4) — there is exactly one reconciliation code path, not two.

### 4.4 Per-meeting lease (serialization)

```sql
-- new columns on calendar_event_links
lease_owner TEXT,
lease_expires_at INTEGER
```

Acquiring: `UPDATE calendar_event_links SET lease_owner=?, lease_expires_at=?
WHERE id=? AND (lease_expires_at IS NULL OR lease_expires_at < ?now)`.
`changes=1` means this caller holds the lease; `changes=0` means another
attempt (opportunistic or sweep) is already in flight or very recently
finished — the loser simply no-ops, trusting the holder (or the next
sweep, if the holder dies) to converge the row. TTL ~120s (generous for
a `get`+`update` round trip plus one retry). A crashed holder's lease
expires naturally and the row becomes claimable again — this *is* the
crash-recovery story, not a separate mechanism.

### 4.5 The actual reconcile step (present-state case)

Holding the lease, for `desired_state = 'present'`:

1. If no `google_event_id` is recorded yet, compute it deterministically
   (§6) and record it (so a retry of *this same* reconcile always
   targets the same id, even if the write that follows fails).
2. `events.get(calendarId, google_event_id)`.
   - **404/410, and this id has never been `synced`**: normal — proceed
     to `events.insert` (§6). `201` or `409 already exists` (meaning a
     previous, un-observed attempt actually landed) are both treated as
     success; on `409`, follow with a `get` to retrieve the real etag.
   - **404/410, and this id *was previously* `synced`**: the owner (or
     someone) deleted the event directly in Google. **Do not
     recreate it.** Transition to `sync_status = 'missing_remotely'`
     (§7.4) and stop — this is Issue 7's explicit requirement.
   - **200**: build the event body fresh from the current `interactions`
     row (§6), `events.update` with `If-Match: "<etag from the get>"`.
     - **200/204 success**: store the new etag, `synced_revision =
       desired_revision`, `sync_status = 'synced'`.
     - **412 Precondition Failed**: something else changed the event
       since the `get` (another writer, or a manual Google edit that
       raced the check). Retry once more (fresh `get` → fresh etag →
       `update`); if it fails a second time, fall to `failed` rather
       than loop indefinitely.
3. Any other error (network, 5xx, timeout, auth failure): `sync_status =
   'failed'`, `attempt_count += 1`, sanitized `last_error` (status/class
   only — mirrors `gmail-client.ts`'s own discipline of never logging a
   raw response body).
4. Release the lease in every exit path (success, failure, or
   `missing_remotely`).

For `desired_state = 'absent'` (cancel): `events.delete`; `2xx`, `404`,
and `410` are all treated as success (idempotent — confirmed this is
Google's own documented behavior for a repeat delete: "no further action
is needed" — [Handle API errors](https://developers.google.com/calendar/api/guides/errors)).
Any other error → `sync_status='failed'` (this *is* "pending deletion
state" — `desired_state='absent'` with `sync_status` not yet `'synced'`
is exactly that state, shown in the UI as *Failed to remove from your
calendar — Retry*, satisfying Issue 3's "failed deletion" requirement
with no new concept needed).

### 4.6 Why this actually solves ordering, not just local bookkeeping

The real guarantee is **not** the lease — a lease only reduces how often
two FOS-side attempts race each other. The real guarantee is that
**every mutating call to Google carries a condition Google itself
enforces**: `events.insert` is rejected by Google on an id collision;
`events.update` is rejected by Google via `If-Match` if the event
changed since this caller's last read. An older, slow request that
somehow still lands *after* a newer one will present a now-stale etag
and get `412` from Google directly — not from FOS's own database. The
lease is defense-in-depth that makes this rare; the etag check is what
makes it *safe* even when it isn't rare enough.

---

## 5. Issue 4 — Verified account, real disconnect, credential safety

### 5.1 Verify through Google, not a typed label

Request one additional, narrow, standard scope alongside Calendar access
(`openid` + `.../auth/userinfo.email` — the same mechanism every "Sign
in with Google" integration uses to answer "which account is this
token for," unrelated to Calendar-specific permissions). At setup time,
and again on **every** sync attempt (cheap — the access token already
being minted for the Calendar call can resolve identity via Google's
standard `tokeninfo`/`userinfo` endpoint with no extra authorization
round trip), FOS calls this to get the authorized account's real email.

### 5.2 Hard refusal if the account doesn't match

```
isCalendarSyncAllowed(environment, verifiedEmail, calendarId):
  if environment == "production-independent":
    return verifiedEmail == "sgoldstein@nirc.edu" and calendarId == "primary"
  if environment == "staging-independent":
    return STAGING_TEST_CALENDAR_ID is set
       and calendarId == STAGING_TEST_CALENDAR_ID
       and calendarId != "primary"
       and verifiedEmail != "sgoldstein@nirc.edu"   -- extra belt-and-braces: Staging's token must not even BE the owner's real account
  return false
```

Checked **at the call site**, inside the same guard module that holds
the environment check (§8) — not only in Settings' display logic. If the
authorized token resolves to any email other than `sgoldstein@nirc.edu`
on Production, **every sync attempt refuses outright** and Settings
shows *Connected, but wrong account — sync disabled*, never a silent
sync to the wrong calendar. This directly satisfies Issue 4's "refuse
Production sync if it does not match sgoldstein@nirc.edu's primary
calendar."

### 5.3 Settings display

Settings shows the **live-verified** email and calendar id (re-checked
each page load, cheap read), not a value the owner typed in once — the
first draft's "manually entered label" is removed entirely.

### 5.4 Real disconnect — a persisted, enforced flag

A new boolean, `calendar_sync_enabled`, persisted on `users` (consistent
with the rest of FOS's per-owner settings, e.g. `timezone`). **Every**
call site that could reach Google — the opportunistic trigger and the
reconciliation sweep alike — checks `calendar_sync_enabled === true`
*and* the identity/calendar check in §5.2 *and* that credentials are
present, before doing anything. "Disconnect" in Settings sets this flag
to `false`; that is the actual, enforced stop — not merely clearing a
displayed label, which was the first draft's gap. Reconnecting flips it
back to `true` with no automatic backfill (unchanged from §9.4).

### 5.5 Credentials never reach the browser

The three `GOOGLE_CALENDAR_OAUTH_*` Worker secrets are read only inside
server-side route handlers / the scheduled handler, exactly like
Gmail's. No API response, server component prop, or client bundle ever
carries them. A dedicated safety test (`tests/calendar-sync-
safety.test.mjs`, modeled on the existing `tests/agenda-safety.test.mjs`)
asserts this by source inspection: no response body construction
references `GOOGLE_CALENDAR_OAUTH_`, no client (`"use client"`) module
imports the Calendar API client module, and the error-handling path
never logs a raw response body (mirroring `gmail-client.ts`'s existing,
tested discipline).

---

## 6. Deterministic event ids across reopening (Issue 3, continued)

Because a deleted Google event's id can never be reinserted (§4.1), the
id cannot be a pure, static function of `interactions.id` alone forever
— it must change across a cancel→reopen cycle.

```sql
-- new column on calendar_event_links
generation INTEGER NOT NULL DEFAULT 0
```

`google_event_id = base32hex(hash(interaction_id || ':' || generation))`
(exact hash choice/encoding is an implementation detail; the only
requirement is determinism — the same `(interaction_id, generation)`
pair always yields the same id, so retries within one generation stay
safe, per §4.1's charset/length rules).

- **First schedule**: `generation = 0`.
- **Cancel**: `desired_state = 'absent'` (§4.2); `generation` is **not**
  bumped yet — the row still remembers which id was deleted.
- **Reopen** (the existing outcome route's `undo`/reopen action, applied
  to a meeting whose calendar link is `desired_state='absent'`):
  `generation += 1`, a **new** deterministic id is computed for the new
  generation, `google_event_id` is updated to it, `desired_state =
  'present'`, `desired_revision += 1`, `sync_status = 'pending'`. The
  next reconcile inserts under the **new** id — the old, tombstoned id
  from generation 0 is never touched again. **The link row itself is
  never deleted** across this cycle (Issue 3's explicit requirement) —
  it is the same row, now on its second generation.

### 6.1 Durable history across generations

```sql
CREATE TABLE calendar_event_link_history (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES calendar_event_links(id),
  generation INTEGER NOT NULL,
  google_event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','rescheduled','cancelled','reopened','missing_remotely','sync_failed')),
  detail TEXT,              -- status-code/class only, same discipline as last_error
  created_at INTEGER NOT NULL
);
```

Append-only, one row per lifecycle transition — a full, durable audit
trail of every generation a meeting's calendar link ever went through,
satisfying "retain durable link/history records" directly, independent
of what the current row's live state happens to be.

### 6.2 Repeated cancellation

If `desired_state` is already `'absent'`, a second cancel request is a
pure no-op at the FOS layer — `desired_revision` is not bumped again (no
new work is actually needed), matching the idempotent-409-style guard
the rest of the codebase already uses for "already inactive" cancels.

---

## 7. Issue 5 — All-day storage (resolving the §3.5/§5.2 contradiction)

The first draft's contradiction: §3.5 implied an all-day meeting's date
lived inside `occurredAt` as "the start-of-day instant," while §5.2
talked about "the meeting's stored date" without ever saying where that
date actually lives — and neither said what `occurredAt` even means once
a meeting has no time-of-day. This revision fixes it by **not** encoding
an all-day meeting as any kind of instant at all, applying the exact
lesson from this same session's own Meeting-Prep date-only bug fix
(`lib/relationships/meeting-brief.ts`): a calendar date is not a
timestamp, and treating it like one is precisely the bug class to avoid
repeating here.

### 7.1 New representation

```sql
-- new columns on interactions (and mirrored on trip_prospects, §7.3)
all_day INTEGER NOT NULL DEFAULT 0,
all_day_date TEXT,     -- 'YYYY-MM-DD', the ONLY source of truth for an all-day meeting's date
end_at INTEGER,         -- nullable end instant, TIMED meetings only (§9.3)
location TEXT
```

- `all_day_date` is a plain calendar-date string — never an epoch, never
  anchored to midnight in any timezone. It is set/read directly,
  identically to how Google's own `event.start.date` field works (not a
  coincidence — this is deliberately the same representation on both
  sides, so the sync layer does zero timezone math for all-day events).
- `occurredAt` **stays `NOT NULL`** (no existing-column type change) and
  is still populated for an all-day row, but is now explicitly a
  **derived display value only** — the start of `all_day_date` converted
  once via the existing `zonedTimeToUtc()` in the relevant timezone
  (fundraiser's or trip destination's), recomputed whenever
  `all_day_date` changes, never hand-edited independently. It exists so
  every *existing* piece of code that sorts/filters/displays by
  `occurredAt` (Today, the interactions timeline, Meeting Prep's
  schedule section) keeps working unmodified for an all-day row. **The
  calendar-sync layer never reads `occurredAt` for an all-day
  meeting** — it reads `all_day_date` directly and does pure
  calendar-date string arithmetic.
- Google's `end.date` is exclusive (documented as "(exclusive) end
  time" — [Events reference](https://developers.google.com/calendar/api/v3/reference/events);
  the "day after the last day" framing is the universally-applied
  convention for this field, consistent with the iCalendar `DTEND`
  semantics Google Calendar implements, though FOS only ever creates
  single-day all-day meetings, so this is always exactly `all_day_date +
  1 day`, computed via the existing `addCalendarDays()` helper — pure
  calendar-day string arithmetic, no epoch/DST involvement at all).
  **To verify empirically against one real created event before relying
  on it for anything beyond the single-day case** (flagged honestly,
  not asserted with more confidence than the docs themselves state).
- Neither `start.timeZone` nor `end.timeZone` is sent for an all-day
  event — Google's reference documents `timeZone` as applying to the
  `dateTime` (timed) form; the `date` form carries no time component to
  attach a zone to.

### 7.2 Timed meetings unaffected

For `all_day = 0` (the default, and every existing row), nothing changes
from the already-reviewed §5.1 pipeline: `occurredAt`/`end_at` are true
instants, built via `zonedTimeToUtc()`, synced as `start.dateTime`/
`end.dateTime` with an explicit IANA `timeZone`.

### 7.3 Trip Planning mirror compatibility

`trip_prospects` already denormalizes `meeting_at`/`meeting_location`
purely for trip-UI display (never a second source of truth —
confirmed in §1). This design mirrors `all_day`/`all_day_date` the same
way, written by the same `scheduleProspectMeeting()`/
`completeProspectMeeting()` functions that already write the other
mirrored fields — never a second, independent write path.

### 7.4 Existing-meeting compatibility

Every pre-existing `interactions` row gets `all_day=0`, `all_day_date=
NULL`, `end_at=NULL`, `location=NULL` from the migration's column
defaults — correctly representing "a timed meeting, with no known end
time or location yet, not an all-day one." Nothing about a pre-existing
row's meaning changes. `occurredAtDateOnly` (the Monday-import-only
column) is untouched and conceptually unrelated, as established in the
reviewed draft.

---

## 8. Issue 7 — Existing meetings vs. Google-side edits

### 8.1 Retrying a known-failed sync vs. enrolling a never-synced meeting

These are different operations with different trust levels, and the
schema already distinguishes them without extra concepts:

- **Retry** (`sync_status = 'failed'`, a `calendar_event_links` row
  already exists): the owner already asked for this meeting to be
  synced once; retry just re-attempts the existing `desired_state`/
  `desired_revision` via the normal reconcile path (§4.5). No new
  consent needed — this is continuing work the owner already started.
- **Enroll** (no `calendar_event_links` row exists at all for an
  `interactions.id` that predates this feature, or that the owner never
  opted into syncing): **never automatic** (unchanged, firmly
  recommended in §9.4/§11). If a "sync this existing meeting" action is
  ever built, it is a distinct, explicit, one-row-at-a-time action that
  creates a brand-new `calendar_event_links` row at `generation=0`,
  `desired_state='present'`, `desired_revision=1` — functionally
  identical to a first-time schedule, just triggered later and
  deliberately.

### 8.2 Manual edit/delete directly in Google

Both cases are detected by the **same** `events.get` that already begins
every present-state reconcile (§4.5) — no separate polling or webhook is
needed, since FOS only ever looks when it already has a reason to
(a real `desired_revision` change, or a retry):

- **Manually deleted** (404/410 on an id that was previously `synced`):
  `sync_status → 'missing_remotely'`. **FOS does not recreate it.** The
  UI shows *Removed from your calendar* with an explicit, separate
  **Recreate** action (bumps `generation`, same mechanism as reopening,
  §6) — never silent, never automatic. This is the direct fix for "do
  not recreate events unexpectedly."
- **Manually edited** (event still exists, but its fields now differ
  from what FOS last pushed): if `desired_revision == synced_revision`
  (FOS has no pending change of its own), the reconciler has **no reason
  to touch the row at all** — a routine sweep tick only acts on rows that
  need reconciliation, so a manual Google-side edit to an otherwise
  untouched meeting is left alone indefinitely. The *next time* FOS
  itself legitimately changes that meeting (a real reschedule), the
  normal `get`→`update` flow fetches the *current* (manually-edited)
  etag and overwrites it with FOS's current truth — consistent with, and
  no stronger than, the existing one-way-sync disclosure ("edits made in
  Google do not update FOS"); it does not newly break anything, it just
  means a manual Google edit does not block FOS's own next real update
  either.

---

## 9. Proposed defaults (converted from questions to recommendations)

1. **Default meeting duration: 30 minutes**, shown and editable at
   scheduling time, stored explicitly in `end_at` once confirmed — never
   silently applied and hidden.
2. **Location: manual entry only**, with an **explicit, one-click
   "Fill in [Donor]'s address" button** the owner must actively press —
   never auto-populated. This satisfies the request for an "optional
   explicit donor-address fill" while keeping a donor's home address off
   any calendar event the owner didn't deliberately choose to put it on.
3. **All-day scheduling is supported in both Capture and Trip Planning**
   — the same new `all_day`/`all_day_date` fields and UI toggle in both
   forms, since both already share one backend function (§1).
4. **Single-donor meetings only for v1** — group/shared activities stay
   out of scope (§1); revisit only if actually requested later.
5. **No automatic enrollment of existing meetings, ever, by default** —
   confirmed firm, not just for initial launch. §8.1 defines the
   distinct "enroll" action as a possible later addition, not part of
   this build.

---

## 10. Issue 6 — Permissions and Staging, verified against current documentation

### 10.1 Least sufficient Google permission

Two scopes for FOS's Google Cloud project, both added to the existing
consent screen alongside (never replacing) Gmail's `gmail.send`:

- **`https://www.googleapis.com/auth/calendar.events.owned`** — narrower
  than the originally-proposed `calendar.events`: it "covers viewing,
  creating, changing, and deleting events **only on calendars the user
  owns**," explicitly excluding calendars merely shared with the
  account ([Calendar API auth guide](https://developers.google.com/calendar/api/auth)).
  Since the only destination this feature ever writes to is the owner's
  own primary calendar (a calendar the account inherently owns — it
  cannot be un-owned while the account exists, per Google's own
  [Calendars & events](https://developers.google.com/workspace/calendar/api/concepts/events-calendars)
  concepts guide), `.owned` covers every operation this design needs
  (`get`, `insert`, `update`, `delete` on events) with less reach than
  `calendar.events`. **Recommendation revised from the first draft**:
  use `.owned`, not the broader `calendar.events`.
- **`openid` + `.../auth/userinfo.email`** — standard, non-sensitive
  identity scopes, for the account-verification mechanism in §5.1. Not
  Calendar-specific; does not grant any calendar access itself.

Internal app type (same Workspace org already confirmed real for Gmail —
`nirc.edu`), avoiding the Testing-mode 7-day refresh-token-expiry trap,
unchanged from the first draft.

### 10.2 Staging: explicit test calendar required, "primary" always refused

A new var, `CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID` (plain `vars`, not a
secret — it's just an id string, not sensitive), must be set to a real,
non-empty, non-`"primary"` calendar id before Staging will ever attempt
a live sync, **even with the Staging opt-in otherwise enabled** — see
the exact guard logic in §5.2, which refuses `calendarId == "primary"`
unconditionally on Staging and additionally refuses if the verified
account identity happens to equal `sgoldstein@nirc.edu` at all (so even
an accidental Production-credential copy onto Staging is refused, not
merely a wrong calendar id). The owner creates this disposable test
calendar themselves, in their own Google account, specifically for this
purpose (§12, setup step).

### 10.3 Confirmed `events.delete` idempotency

A repeat delete on an already-deleted event (or one that never existed)
returns `410`/`404`; Google's own error-handling guide says "no further
action needed" for this case ([Handle API errors](https://developers.google.com/calendar/api/guides/errors)) —
directly backing the idempotent-cancel design in §4.5.

---

## 11. Remaining genuine open questions (not converted to defaults)

Everything that could be reduced to a concrete recommendation has been
(§9). Two items remain genuinely open because they depend on
information only the owner has:

1. **Staging test calendar ownership**: the owner needs to actually
   create a disposable Google Calendar for Staging verification (§10.2)
   before Staging testing can happen live — this is an action for the
   owner to take, not a design choice to resolve on paper.
2. **Whether an "enroll an existing meeting" action is ever wanted
   post-launch** (§8.1) — firmly deferred, not built in v1 either way,
   but worth a yes/no for the backlog rather than silence.

No architectural blocker remains. Every mechanism in §3–§8 is concrete
enough to implement directly from this document.

---

## 12. Google Cloud / OAuth setup steps (separated from architecture)

Performed once by the owner, exactly mirroring the already-executed
Gmail setup, **in the same Google Cloud project** (simpler
administration, same org) but as a **new, separate OAuth 2.0 Client ID**
— never reusing Gmail's client or token:

1. In the existing Google Cloud project (the one already used for
   Gmail), enable the **Google Calendar API** (APIs & Services →
   Library) — the Gmail API's enablement is untouched.
2. OAuth consent screen (APIs & Services → OAuth consent screen): add
   `https://www.googleapis.com/auth/calendar.events.owned`, `openid`,
   and `.../auth/userinfo.email` to the scope list, **alongside** the
   existing `gmail.send` entry — never remove or modify it.
3. Create a **new** OAuth 2.0 Client ID (Desktop app type, same reason
   as Gmail's — supports the one-time manual authorization flow with no
   hosted redirect URI needed).
4. **Production authorization**: the owner, manually, in a browser,
   authorizes this new client against `sgoldstein@nirc.edu`, once,
   yielding a `client_id`/`client_secret`/`refresh_token` for Production.
   Store as `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`/`_CLIENT_SECRET`/
   `_REFRESH_TOKEN` via `wrangler secret put --config
   wrangler.production.jsonc`.
5. **Staging authorization (separate, later, only when the owner is
   ready to live-test)**: a second manual authorization, against the
   same or a different account, but pointed at the disposable test
   calendar from §10.2/§11.1 — its own three secrets via `wrangler
   secret put --config wrangler.staging.jsonc`, plus
   `CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID` set as a plain `vars` entry
   in `wrangler.staging.jsonc`.
6. Add the new 5-minute reconciliation Cron Trigger (§4.3) to
   `wrangler.production.jsonc`'s `triggers.crons` **only after** Staging
   verification is complete and approved (mirrors the Gmail rollout's
   own "deploy the handler, activate the trigger as a separate, later,
   explicitly-approved step" sequencing).

No step above has been performed by this design pass — this is the
checklist for when implementation is approved, not a record of actions
taken.

---

## 13. Failure-scenario acceptance tests

Each row is a concrete scenario this design must handle correctly before
it ships; intended to become real automated tests (unit tests against a
mocked Calendar client for most rows, since the `lib/calendar/` logic is
split pure/impure the same way `lib/agenda/` already is).

| # | Scenario | Required outcome |
|---|---|---|
| 1 | Double-click "Save" on a brand-new Capture meeting | Exactly one `interactions` row, exactly one synced Google event (§3) |
| 2 | Create request times out before the client sees a response; client retries with the same client-chosen id | Still exactly one `interactions` row (§3) and, separately, exactly one Google event even if the first attempt's `events.insert` had actually already landed (§4.5 step 2, `409`-as-success path) |
| 3 | Calendar `insert` succeeds at Google, but FOS crashes/loses connectivity before recording `sync_status='synced'` | Next reconcile's `insert` with the same deterministic id gets `409 already exists`, self-heals to `synced` via a follow-up `get` — never a duplicate (§4.5, §6) |
| 4 | Two reconcile attempts for the same meeting start nearly simultaneously (opportunistic + sweep overlap) | Only one acquires the lease; the other no-ops (§4.4) |
| 5 | A reconcile's `events.update` carries a stale etag because something else changed the event first | Google returns `412`; FOS re-fetches and retries once, bounded (§4.5 step 2) |
| 6 | Owner cancels a meeting while its very first create attempt is still ambiguous (timed out, unknown outcome) | Delete is attempted regardless by the known deterministic id; `404`/`410`/success are all treated as "now absent" — no leftover event either way (§4.5) |
| 7 | Owner cancels, then reopens (undo) the same meeting | A new `generation` and a new deterministic id are used; the old, tombstoned Google id is never reinserted (§6) |
| 8 | The linked event is manually deleted directly in Google | Next reconcile's `get` returns `404` on a previously-`synced` id → `missing_remotely`, **not** auto-recreated (§8.2) |
| 9 | The linked event is manually retitled/rescheduled directly in Google, and FOS has no pending change of its own | Left untouched indefinitely — no reconcile attempt happens at all, since nothing needs reconciling (§8.2) |
| 10 | Same as #9, but the owner *then* reschedules the meeting inside FOS | FOS's reschedule wins on the next `update` (fetches the current, manually-edited etag first) — consistent with the one-way-sync disclosure (§8.2) |
| 11 | The Calendar refresh token is revoked/expired | Every sync attempt fails cleanly to `failed`; the FOS meeting itself is completely unaffected; Settings shows a clear reauthorization prompt (§4.5 step 3, §5.3) |
| 12 | Owner clicks Disconnect | `calendar_sync_enabled=false` persisted; a subsequent reschedule of an already-synced meeting makes **no** Calendar API call at all, checked at the guard, not just hidden in the UI (§5.4) |
| 13 | Reconnect after a period disconnected | Sync resumes for new/rescheduled meetings only; nothing missed during the gap is auto-backfilled (§9.5) |
| 14 | Staging, `CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID` accidentally set to `"primary"` | Guard refuses unconditionally, logs a configuration error, makes no Calendar API call (§5.2, §10.2) |
| 15 | Production, but the authorized token's verified email is not exactly `sgoldstein@nirc.edu` | Guard refuses every sync attempt; Settings shows *wrong account* (§5.2, §5.3) |
| 16 | A single-day all-day meeting on March 5 | Google event has `start.date="2026-03-05"`, `end.date="2026-03-06"`, no `dateTime`/`timeZone` fields (§7.1) |
| 17 | A timed meeting scheduled across a DST transition (e.g. the trip-destination timezone's spring-forward date) | `zonedTimeToUtc()`'s existing, already-reviewed self-correcting conversion is reused unchanged (§5.1 of the prior draft, unaffected by this revision) |

---

## 14. Implementation sequence

1. **Migration `0048`** — `calendar_event_links`,
   `calendar_event_link_history`, new nullable `interactions` columns
   (`all_day`, `all_day_date`, `end_at`, `location`), mirrored
   `trip_prospects` columns, `users.calendar_sync_enabled`. Additive
   only; own fresh/upgrade schema test (same pattern as `0047`'s).
2. **Capture idempotent-create fix** (§3) — lands independently of
   Calendar sync; closes a real pre-existing gap and is a prerequisite
   for §3's guarantee.
3. **Pure logic** (`lib/calendar/`, no `cloudflare:workers` import, unit
   -testable without D1 or network): deterministic event-id derivation
   (§6), event-body builder (`interactions`/`trip_prospects` → Google
   event JSON, handling all-day vs. timed per §7), the reconcile
   decision function (link row + fresh interaction state + optional live
   `get` result → next action, per §4.5/§8.2), the environment/identity
   guard (§5.2).
4. **Impure client** (`lib/calendar/google-calendar-client.ts`): token
   refresh against the new, separate secrets; `get`/`insert`/`update`/
   `delete` calls with sanitized error handling (mirrors `gmail-
   client.ts`); lease acquisition and D1 read/write helpers.
5. **Wiring**: hook the durable-intent write (§4.3) into the existing
   interaction create/reschedule/cancel/outcome routes and the trip
   scheduling functions, in the same D1 batch as their existing writes;
   add the `ctx.waitUntil()` opportunistic trigger; add the 5-minute
   reconciliation sweep to `worker/index.ts`'s `scheduled()` handler,
   guarded identically to the agenda cron.
6. **Settings UI**: live-verified connection status (§5.1/§5.3), the
   persisted enable/disable toggle (§5.4), default-duration field,
   disclosure text, Disconnect action.
7. **Per-meeting UI**: status badges and Retry/Recreate actions on the
   donor timeline and trip prospect rows; the all-day toggle and
   duration field in both Capture and the trip-meeting form; the
   explicit donor-address-fill button (§9.2).
8. **Safety test suite** (`tests/calendar-sync-safety.test.mjs`, §5.5)
   plus unit coverage for every row in §13's acceptance-test table.
9. **Staging rollout**: deploy with no Production secrets anywhere near
   Staging; owner creates the disposable test calendar (§11.1) and
   performs the Staging OAuth authorization (§12 step 5); live-verify
   every scenario in §13 that's practical to exercise manually.
10. **Owner review and explicit Production approval** — a separate,
    deliberate decision point, not implied by Staging working.
11. **Production OAuth authorization** (§12 step 4) and secret setup.
12. **Deploy to Production**, with the reconciliation cron still
    inactive; verify the guard refuses sync (no secrets yet configured
    is the natural starting state).
13. **Activate the reconciliation cron** (§12 step 6) as the final,
    separate, explicitly-approved step — mirroring the Gmail rollout's
    own "deploy inert, activate the trigger later" sequencing.
14. **First real verification**: the owner's own next real scheduled
    meeting (or one they schedule and immediately cancel themselves) —
    never a fabricated test donor/interaction on Production.

### Rollback

Unchanged from the prior draft: `wrangler rollback` for Worker code
only; the additive migration and all `calendar_event_links`/
`calendar_event_link_history`/`interactions` data are always retained,
never dropped or reversed as a rollback shortcut. Disconnecting
(`calendar_sync_enabled=false`, §5.4) is the correct, immediate way to
stop all future syncing with no schema change; previously-synced Google
events and all FOS meeting data are unaffected either way.

---

## Sources consulted for this revision

- [Get specific versions of resources (ETag/If-Match)](https://developers.google.com/calendar/api/guides/version-resources)
- [Events: patch reference](https://developers.google.com/calendar/api/v3/reference/events/patch)
- [Events reference (start/end/date/dateTime/timeZone fields)](https://developers.google.com/calendar/api/v3/reference/events)
- [Create events guide (all-day events use start.date/end.date)](https://developers.google.com/calendar/api/guides/create-events)
- [Handle API errors (409 id-exists, 410/404 already-deleted)](https://developers.google.com/calendar/api/guides/errors)
- [Calendar API auth / scopes (calendar.events vs. calendar.events.owned)](https://developers.google.com/calendar/api/auth)
- [Calendars & events concepts (primary calendar ownership)](https://developers.google.com/workspace/calendar/api/concepts/events-calendars)
