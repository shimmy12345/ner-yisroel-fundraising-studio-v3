# D1 Nightly Backup Scheduling Reliability — Investigation & Corrective Plan (2026-08-28)

**Status: investigation/design only.** No workflow YAML, Cloudflare
configuration, GitHub secrets, R2 buckets, Worker bindings, backup
encryption, or application behavior was changed. Nothing was deployed,
dispatched, or mutated. All findings below come from read-only
inspection of `.github/workflows/*.yml` on `main` (the branch scheduled
workflows actually execute from), `docs/DEPLOYMENT.md`,
`status-worker/`, `lib/data-health/model.ts`, and the real GitHub
Actions run history for this repository via the public GitHub REST API
(`api.github.com`, unauthenticated — this repository is public).

---

## 1. Actual last-run-history timeline

The automated backup pipeline is 12 days old as of this investigation
(built and merged to `main` 2026-08-16 through 2026-08-18 — see
`docs/DEPLOYMENT.md`'s "Automated D1 backup" section and commits
`3ca68b5`/`6c482a9`). Its **entire** run history is shown below (a
superset of the requested 14-day window, since a full 14 days of
history doesn't yet exist).

| Date (nominal 08:00 UTC / 4:00 AM EDT) | Event | Actual start (UTC) | Delay | Outcome | Completed (UTC) | Status publish | Backup object key |
|---|---|---|---|---|---|---|---|
| Aug 16 | `workflow_dispatch` (manual setup) | 17:01:36 | n/a (manual) | success | 17:02:09 | succeeded | `daily/...-20260816T1701*Z...` |
| Aug 17 | `workflow_dispatch` (manual setup) | 03:51:38 | n/a (manual) | success | 03:52:04 | succeeded | `daily/...-20260817T0351*Z...` |
| **Aug 17** | **schedule** | 08:32:36 | **+32 min** | success | 08:33:06 | succeeded | `daily/...-20260817T0832*Z...` |
| Aug 17 | `workflow_dispatch` (manual setup) | 15:16:03 | n/a (manual) | success | 15:16:31 | succeeded | — |
| Aug 17 | `workflow_dispatch` (manual setup) | 15:40:24 | n/a (manual) | success | 15:40:52 | succeeded | — |
| **Aug 18** | **schedule** | 08:24:20 | **+24 min** | success | 08:24:47 | succeeded | `daily/...-20260818T0824*Z...` |
| Aug 18 | `workflow_dispatch` (manual setup) | 13:49:14 | n/a (manual) | success | 13:49:46 | succeeded | — |
| **Aug 19** | **schedule** | 08:25:39 | **+26 min** | success | 08:26:08 | succeeded | `daily/...-20260819T0825*Z...` |
| **Aug 20** | **schedule** | 08:26:51 | **+27 min** | success | 08:27:21 | succeeded (verified) | `daily/...-20260820T0826*Z...` |
| **Aug 21** | **schedule** | 08:28:33 | **+29 min** | success | 08:29:00 | succeeded | `daily/...-20260821T0828*Z...` |
| **Aug 22** | **schedule** | 08:18:31 | **+19 min** | success | 08:19:15 | succeeded | `daily/...-20260822T0818*Z...` |
| **Aug 23** | **schedule** | 08:18:55 | **+19 min** | success | 08:19:28 | succeeded | `daily/...-20260823T0818*Z...` |
| **Aug 24** | **schedule** | 08:37:11 | **+37 min** | success | 08:37:42 | succeeded | `daily/...-20260824T0837*Z...` |
| **Aug 25** | **schedule** | 08:31:17 | **+31 min** | success | 08:31:49 | succeeded | `daily/...-20260825T0831*Z...` |
| **Aug 26** | **schedule** | 08:32:20 | **+32 min** | success | 08:32:46 | succeeded | `daily/...-20260826T0832*Z...` |
| **Aug 27** | **schedule** | **18:38:38** | **+10h 39min** | success | 18:39:07 | succeeded (verified: `backup-latest-success.json` says `completedAt: 2026-08-27T18:39:04Z`) | `daily/fundraising-os-staging-db-20260827T183902Z.sql.gz.gpg` (verified via live Workspace Health) |
| **Aug 28 (today)** | **schedule — has not fired** | **— (none as of 15:25 UTC)** | **+7h 26min and counting** | **no run exists yet** | — | — | — |

Object keys for rows not individually confirmed are inferred from the
run's own start timestamp (the `Compute timestamp` step runs seconds
after job start) rather than fetched per-run, since every run's own
step list was not individually pulled — this doesn't affect the
investigation's conclusion, which rests on **trigger timing**, not
export correctness. Two rows (Aug 20, Aug 27) were spot-checked at the
step level and both show every step, including the best-effort status
publish, completed successfully.

**Explicit classification:**

- **Missed calendar days:** none *retroactively confirmed* — every
  calendar day Aug 17–27 eventually got exactly one successful
  scheduled run. **Aug 28 is the first day with no run at all as of
  this report**, and it is impossible to know from outside GitHub
  whether it will still fire later today or was silently dropped —
  that ambiguity is itself the core problem this document addresses.
- **Multi-hour delays:** exactly one so far — Aug 27, **+10h 39min**.
- **Manual runs:** 5, all on Aug 16–18 during initial setup
  (`docs/DEPLOYMENT.md` step 8's "trigger both workflows manually...
  before relying on the schedule alone"). None since.
- **True backup failures:** **zero.** Every run in the repository's
  entire history (16/16) has `conclusion: success`.
- **Status-publication-only failures:** **zero observed.** Both
  spot-checked runs' "Publish backup status" step succeeded; the live
  Workspace Health "Automated backup" card currently shows a
  successful, correctly-populated entry for the Aug 27 run.

### Failure-mode classification (per Section headers in the task)

| Mode | Observed? |
|---|---|
| A. scheduled trigger never started on time | **Yes — this is the entire observed problem.** Every real delay/gap traces to the `schedule` event itself, not anything downstream. |
| B. workflow started but failed | No — 0/16 runs failed. |
| C. backup succeeded but status publication failed | No instance found in the runs inspected. |
| D. dashboard/status ingestion problem | No — the status-worker and Workspace Health card correctly and immediately reflected the Aug 27 run once it (eventually) ran. |

**Confirmed root cause: GitHub Actions' `schedule` trigger itself is
not firing reliably at `0 8 * * *` — this is a platform-level
scheduling problem, not a defect in the backup pipeline.** The backup
mechanism, once triggered, has a 100% success rate across its entire
operational history.

---

## 2. Recommended freshness SLO

The intended requirement, restated precisely: **at least one verified
backup of the live D1 database completes every calendar day, within a
bounded freshness window, without requiring a human to notice a missed
GitHub cron.**

This codebase **already has a working answer to "how stale is too
stale"** — `lib/data-health/model.ts` already defines and ships:

```
BACKUP_FRESHNESS_HEALTHY_MS  = 36 hours   (24h cadence + 12h grace)
BACKUP_FRESHNESS_CRITICAL_MS = 72 hours   (roughly one full missed cycle)
```

These numbers are sound and this investigation does not propose
replacing them — they are the right **dashboard** thresholds (item 13
says not to conflate dashboard/alerting semantics with a new,
disconnected number, and there's no evidence these are wrong: even
Aug 27's 10h39min delay never came close to 36h). What's missing is a
**recovery** threshold — a point, well before the dashboard would ever
show anything but green, at which the system should stop waiting on
GitHub and act on its own.

**Recommended three-tier SLO, reusing the existing constants as two of
the three tiers:**

| Tier | Threshold | Meaning | Who acts |
|---|---|---|---|
| **Fresh** | < 26h since last verified success | Normal — cadence is ~24h plus GitHub's observed jitter (up to ~40 min normally observed; treat up to a couple hours as unremarkable) | No one |
| **Recovery** | ≥ 26h | The nightly schedule should have fired by now and didn't (or fired and failed) — self-heal automatically | **The watchdog** (Section 12) |
| **Escalate** | ≥ 36h (existing `BACKUP_FRESHNESS_HEALTHY_MS`) | The watchdog *itself* has now also failed to restore freshness (dispatch failed, GitHub API down, or the dispatched run also failed) | **A human**, via active alert (Section 10) |
| **Critical** | ≥ 72h (existing `BACKUP_FRESHNESS_CRITICAL_MS`) | Unchanged existing dashboard tier — two full cycles missed | Escalation already fired at 36h; this is the "how did nobody act on the alert" backstop |

**Why 26h, not the task's example 24h/26h/28h verbatim:** 24h is too
tight — it would fire the watchdog on essentially *every single day*
given the observed 19–37 minute normal jitter plus any reasonable
buffer, producing noise, not signal. 26h gives ~2h of headroom over the
worst normal delay observed (37 min) while catching the Aug 27 case
(10h39min) more than 8 hours before a human would ever see anything but
green on the dashboard. Using the *existing* 36h constant as the
escalation tier (rather than a new "28h" number) means the recovery
window and the escalation window are provably 10 hours apart — enough
time for a dispatched backup (which takes ~30 seconds to run once
started, per every observed run) to complete and be reflected, with
margin for a retry, before a human is ever paged.

---

## 3. GitHub Actions scheduler: documented limitations vs. observed behavior

Confirmed directly from current GitHub documentation (`docs.github.com`,
"Events that trigger workflows" → `schedule`):

> "The `schedule` event can be delayed during periods of high loads of
> GitHub Actions workflow runs. **High load times include the start of
> every hour.** If the load is sufficiently high enough, **some queued
> jobs may be dropped.**"
>
> "The shortest interval you can run scheduled workflows is once every
> 5 minutes."
>
> "This event will only trigger a workflow run if the workflow file
> exists on the default branch," and "Scheduled workflows will only run
> on the default branch."
>
> "In a public repository, scheduled workflows are automatically
> disabled when no repository activity has occurred in 60 days."
>
> Recommendation: "To decrease the chance of delay, schedule your
> workflow to run at a different time of the hour."

**Applied to this repository:**

- **Default branch requirement: satisfied.** `main` is confirmed the
  repository's default branch (`GET /repos/.../ ` →
  `"default_branch": "main"`), and both workflow files exist there with
  current content (verified directly, not assumed).
- **60-day inactivity auto-disable: not applicable.** This repository
  had a push as recently as ~1 hour before this investigation
  (`pushed_at: 2026-08-28T14:21:40Z`) and is not archived or disabled.
- **The cron is scheduled for `0 8 * * *` — exactly the top of the
  hour, GitHub's own documented worst-case window ("high load times
  include the start of every hour").** This is a real, actionable, if
  partial, contributing factor: every single day, this workflow
  competes for scheduling capacity at the single most congested minute
  of the hour, across every GitHub Actions customer globally, not just
  this repository.
- **"Some queued jobs may be dropped" is an explicit, official
  admission that schedule events are not merely "sometimes late" but
  can be lost outright with no compensating retry from GitHub's side.**
  This is the crux of why a same-platform watchdog (Option A) cannot
  fully solve this problem — see Section 5.
- **Concurrency interactions:** `concurrency: { group: d1-nightly-backup,
  cancel-in-progress: false }` only governs runs *within this
  repository's own queue*, once GitHub has decided to create a run at
  all. It has no bearing on whether the `schedule` event itself is
  fired or dropped upstream of that queue.
- **Can a delayed queued run overlap a watchdog-dispatched run?** Yes,
  in principle — GitHub's own queuing/scheduling internals aren't
  externally observable in real time. `cancel-in-progress: false` means
  if this happens, the second run **queues behind the first rather than
  being cancelled or racing it** (Section 8).

**Distinguishing documented guarantee from observed behavior:** GitHub
documents *that* delay/drop can happen but gives no SLA, percentile, or
bound on how long or how often — "best-effort" is contractually the
entire guarantee. The 10h39min Aug 27 delay and the (at minimum)
7h26min-and-counting Aug 28 gap are this repository's own **first
direct observed instances** of that documented risk materializing in a
way that matters operationally — not a one-off fluke to shrug off, and
not (per the evidence in Section 1) any kind of bug in this project's
own workflow code.

---

## 4. Architecture options evaluated

### Option A — GitHub-only watchdog (second GitHub Actions cron)

A second scheduled workflow (e.g. every 2 hours) that reads backup
freshness and calls `workflow_dispatch` on the backup workflow if
stale.

- **Cost:** near zero — no new secrets (a same-repo `workflow_dispatch`
  can be issued with the job's own default `GITHUB_TOKEN` if `actions:
  write` permission is granted to it, or by reusing the existing
  read-only status data).
- **Honest challenge (per the task's own instruction):** this
  workflow's own `schedule` trigger is subject to **the exact same
  platform-wide "high load"/"may be dropped" behavior** as the primary
  backup schedule, on the exact same repository, evaluated by the exact
  same GitHub Actions scheduling subsystem. It is not a second,
  independent die roll against a *different* source of unreliability —
  it is the *same* source of unreliability, checked twice. It would
  likely catch cases where the two schedules' *individual* queuing
  happens to be decorrelated (plausible, since delay is a per-workflow-run
  phenomenon, not always a total platform outage), but it provides **no
  protection against the exact failure category GitHub explicitly
  documents as the worst case: a broad, high-load period where GitHub
  itself is dropping queued jobs across the board** — precisely the
  scenario this task is asking to be protected against.
- **Verdict: rejected as the primary mechanism.** Cheap and not
  worthless, but fails the stated independence requirement (Section 5)
  by construction, not merely as a caveat.

### Option B — Cloudflare Cron watchdog (the task's starting hypothesis)

Keep GitHub Actions as the system that performs the real backup.
Add a Cloudflare Cron Trigger that checks backup freshness and, if
stale, calls GitHub's `workflow_dispatch` API.

- **This repository already runs exactly this pattern today**, for a
  different purpose: `wrangler.staging.jsonc` already declares
  `"triggers": { "crons": ["0 * * * *"] }` (hourly), and
  `worker/index.ts`'s `scheduled()` handler already fires every hour,
  delegating to a guard function (`isDailyAgendaSendHour()` in
  `lib/agenda/send-agenda.ts`) that makes the other 23 invocations a
  silent no-op. This is proven, already-shipped, already-tested
  infrastructure for "cheap hourly Cloudflare-side check, act only when
  a condition is met" — not a new pattern to invent.
- **Genuinely independent failure domain:** Cloudflare Cron Triggers
  run on Cloudflare's own scheduling infrastructure, entirely separate
  from GitHub Actions. A GitHub-side scheduling degradation has no
  mechanism by which it could also delay a Cloudflare Cron Trigger, and
  vice versa.
- **Minimal new privilege, if hosted correctly (see Section 6):** the
  *freshness check* needs no new credential at all (reuses the existing
  read-only `STATUS_BUCKET` R2 binding already on `status-worker`); only
  the *dispatch* action (taken rarely — only when actually stale) needs
  one new, narrowly-scoped GitHub credential.
- **Verdict: recommended.** See Section 14 for the final, specific
  architecture (which host Worker, exact scopes) and why it refines
  rather than simply restates the starting hypothesis.

### Option C — Cloudflare performs the backup itself

Investigated and **rejected**, not merely because Cloudflare has cron
triggers, but on the specific dimensions the task asked to evaluate:

- **D1 export capability:** `wrangler d1 export`'s actual work happens
  against Cloudflare's D1 HTTP API using the Cloudflare account API
  token (`CLOUDFLARE_D1_API_TOKEN`) — a Worker *could* call the same
  underlying endpoint via `fetch()`, but only by holding that same
  token itself. Today, that token exists **only** as a GitHub Actions
  secret, on an ephemeral runner that exists for ~30 seconds per run
  and is destroyed after. Moving export into a Worker means the token
  now lives in a long-running, continuously-deployed Cloudflare
  execution environment instead.
- **Encryption:** the current pipeline shells out to `gpg --symmetric
  --cipher-algo AES256`, a mature, battle-tested tool. The Workers
  runtime has no subprocess/shell environment and no `gpg` binary —
  reproducing this would mean writing a new AES-256 symmetric
  encryption implementation against the Web Crypto API (`SubtleCrypto`)
  from scratch, then re-validating it byte-for-byte against the
  existing restore pipeline's expectations. This replaces a proven tool
  with new, unaudited cryptographic code for no functional gain.
  **This alone is enough to reject Option C** — the task's own
  constraint ("do not weaken... encryption") is best honored by not
  touching the encryption step's implementation at all.
- **Secure key/passphrase handling:** doing the export, encryption, AND
  R2 write in one Worker means the D1 token, the encryption passphrase,
  and the R2 write credential would all need to live together in one
  Cloudflare Worker's secrets — collapsing three currently-separate
  blast radii (deliberately split across distinct GitHub secrets today,
  per `docs/DEPLOYMENT.md`'s "Credential separation") into a single
  Cloudflare execution environment. This is a **strictly worse**
  security posture than today's, not a neutral lateral move.
- **R2 write isolation:** the whole point of the current design is that
  the *application's* Cloudflare account presence has no R2 write
  access to backups at all (`wrangler.staging.jsonc` has no
  `r2_buckets` binding, enforced by `tests/backup-automation.test.mjs`).
  A backup-performing Worker — even a separate one from the main
  app — reintroduces a live, persistently-deployed Cloudflare-side
  credential with backup-bucket write access, something that currently
  exists nowhere outside a 30-second GitHub runner.
- **Restore compatibility:** `scripts/verify-remote-restore.mjs` and the
  monthly restore-verification workflow are built and tested against
  the *exact* byte shape `wrangler d1 export` (run via the GitHub
  Actions pipeline) produces. Re-implementing export in a different
  runtime risks a subtly different SQL dump shape, requiring the entire
  restore/verify pipeline to be re-validated against a new producer —
  real work, for a producer (GitHub Actions) that has never once failed
  in this repository's history (Section 1).
- **Verdict: rejected.** Materially worse security posture, real new
  engineering/testing risk, and does not even uniquely solve the stated
  problem (a Cloudflare Cron Trigger can dispatch GitHub *or* run its
  own backup with equal ease — the reliability win comes from the
  *trigger*, not from *where the export runs*).

### Option D — External independent scheduler (third-party cron service)

- Would add a fourth party to a system that currently trusts exactly
  two (GitHub, Cloudflare), both already deeply integrated and
  understood in this codebase. The credential needed to call GitHub's
  `workflow_dispatch` API would need to live in yet another vendor's
  secret store, with its own unaudited reliability/security posture,
  purely to decorrelate from a risk that Option B *already*
  decorrelates from by using Cloudflare (a platform this repo already
  depends on for hosting the entire application).
- **No material reliability advantage over Option B** — GitHub and
  Cloudflare are already two genuinely independent companies/platforms
  with uncorrelated infrastructure; a third vendor doesn't meaningfully
  improve on "independent of GitHub," it only adds a new dependency,
  new credential surface, and new operational unfamiliarity.
- **Verdict: rejected**, per the task's own instruction to recommend
  this "only if it provides material reliability/security advantages
  over Cloudflare Cron" — it does not.

### Option E

No architecture beyond A–D was identified that better fits this
repository's existing infrastructure and constraints; not invented for
its own sake.

---

## 5. Independence analysis (common-mode failure)

The core question: **if GitHub's scheduler is the failure domain being
protected against, does the watchdog fail independently of it?**

- **Option A (second GitHub cron): No.** Both the primary schedule and
  the watchdog schedule are `schedule`-triggered workflows in the same
  repository, subject to the same platform-wide high-load/drop
  behavior GitHub documents. A broad GitHub Actions scheduling
  degradation is a **common-mode event** for both — exactly the
  scenario that matters most is the one this option cannot protect
  against.
- **Option B (Cloudflare Cron): Yes.** Cloudflare Cron Triggers do not
  depend on, share infrastructure with, or have any documented
  correlation to GitHub Actions' scheduling subsystem. A GitHub-side
  degradation (the actual observed event: Aug 27/28) has zero
  mechanism to also delay or drop a Cloudflare Cron Trigger. This is a
  genuine, structural independence, not merely "probably fine most of
  the time."
- Note the converse also holds and is worth stating plainly: **if
  Cloudflare's own Cron Trigger infrastructure were ever the thing
  having a bad day, the *primary* GitHub-based backup would be
  completely unaffected** — the backup itself never depends on
  Cloudflare Cron at all, only the watchdog does. The system degrades
  to "no watchdog today" in that case, not "no backup today."

---

## 6. Security boundary analysis

**What the watchdog does NOT need, and will not get:**

- D1 backup-write authority (`CLOUDFLARE_D1_API_TOKEN`) — never touched.
- The backup encryption passphrase (`BACKUP_ENCRYPTION_PASSPHRASE`) —
  never touched; the watchdog never sees backup content, only a status
  timestamp.
- R2 backup object *contents* — the watchdog's freshness check reads
  only the existing status bucket (`fundraising-os-backup-status`,
  already bound read-only to `status-worker` today), never
  `fundraising-os-staging-backups`.
- Broad GitHub repo access — no `contents:write`, no PR/issue/admin
  scopes of any kind.

**What the watchdog needs, precisely, and why:**

| Capability | Scope | Why |
|---|---|---|
| Read `backup-latest-success.json` / `backup-latest-attempt.json` | Existing `STATUS_BUCKET` R2 binding, already on `status-worker`, read-only, unchanged | Freshness determination |
| Trigger `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` | **One new** fine-grained GitHub personal access token, scoped to **this one repository only**, with the **"Actions" repository permission set to Read and write, and nothing else** | This is confirmed, from current GitHub documentation, to be the complete permission requirement for this endpoint — "Additional Permissions: None required" (specifically, no Contents permission of any kind is needed). This is the narrowest credential GitHub's permission model can express for this action. |

A GitHub App with an auto-expiring (1-hour) installation token would be
narrower still (no long-lived secret to leak at all), but is not
recommended here: it adds real setup/operational complexity (App
registration, private key + App ID + Installation ID management, token
refresh logic) for a security improvement that is marginal once the
fine-grained PAT is already scoped to exactly one permission on exactly
one repository. Documented as a future hardening option, not the
initial recommendation, in the interest of "low operational complexity."

**Where this credential must live — and must not:**

The main application Worker (`worker/index.ts` / `wrangler.staging.jsonc`)
**must never receive this token.** It already reaches backup status
read-only via the existing `STATUS_WORKER` service binding (no
credential at all — a service binding is not a secret) and has no
reason to gain any new capability. The GitHub dispatch token belongs
**only** on `status-worker` — the Worker already purpose-built and
already isolated for exactly this kind of narrow, backup-pipeline-
adjacent operational concern (see Section 14 for the specific reasoning
on why `status-worker` over the main app Worker).

---

## 7. Status-source-of-truth analysis

**Question:** could status publication fail while the real backup
succeeded, causing the watchdog to falsely conclude staleness?

**Yes, structurally possible** (the nightly workflow's own comments
say so explicitly: publish is `continue-on-error: true`, `if: always()`,
deliberately allowed to fail without failing the job) — **though not
observed even once** in this repository's actual history (Section 1;
both spot-checked runs, including the one non-trivial delay case,
show the publish step succeeding).

**Resolution chosen: tolerate the rare false-stale case by accepting an
occasional harmless duplicate dispatch (task's option A), rather than
granting the watchdog any new access to the real backup bucket (option
B).**

Reasoning:
- Reading `latest/`'s R2 metadata (option B) would require granting
  `status-worker` its first-ever access, even read-only/metadata-only,
  to the *real* backup bucket — a boundary this project has deliberately
  never crossed (`docs/DEPLOYMENT.md`: "The deployed Worker has no
  credential capable of reading, writing, or deleting anything in the
  backup bucket" — and while `status-worker` isn't "the deployed
  Worker" in the application sense, extending *any* Cloudflare-side
  Worker's reach into the real backup bucket is the same category of
  boundary-crossing this architecture was built to avoid).
- The concrete cost of getting this wrong (dispatching an unnecessary
  extra backup because status publication silently failed) is a ~30-
  second GitHub Actions job and one extra, harmless, immutable `daily/...`
  object — bounded, cheap, and self-cleaning via the existing 90-day R2
  lifecycle rule. This is explicitly *not* the same as weakening
  anything about the real backup or its retention.
- The task explicitly prohibits weakening the rule that status
  publication can never fail a successful backup job — this resolution
  doesn't touch that rule at all; it only decides what the *consumer*
  of that best-effort signal should do when the signal itself might be
  stale/missing, which is a new, additive concern.

**One free refinement, at zero additional privilege:** the watchdog
should read **both** `backup-latest-success.json` and
`backup-latest-attempt.json` (both already in the same, already-bound
bucket) and apply the same "a known-failed most-recent attempt floors
the status" logic `lib/data-health/model.ts`'s `pipelineStatusCheck`
already implements (`attemptIsNewerFailure`) — reusing that exact,
already-tested pure logic (or the same constants/shape) rather than
inventing a second, potentially-drifting freshness rule.

---

## 8. Race / concurrency analysis

Given the real workflow's `concurrency: { group: d1-nightly-backup,
cancel-in-progress: false }`:

- **Do runs queue safely?** Yes. `cancel-in-progress: false` means a
  second run for the same concurrency group is queued, never cancels
  the first. GitHub Actions serializes runs within a concurrency group;
  they never execute in parallel against each other.
- **Do both eventually create separate immutable dated backups?** Yes —
  each run computes its own `steps.stamp.outputs.value` (current UTC
  timestamp at that run's own execution), producing a distinct
  `daily/<name>-<timestamp>.sql.gz.gpg` key. No collision is possible
  between two runs that start even one second apart.
- **Does `latest/` remain correct?** Yes — whichever run's `PutObject`
  completes *last* wins, and its content+metadata are written together
  atomically (documented and unchanged). "Correct" here means "reflects
  a real, current, valid export" — it does, regardless of which of two
  same-day runs happens to finish second.
- **Are duplicate same-day backups harmless?** Yes, per all of the
  above, plus the existing 90-day retention lifecycle rule bounding
  their storage cost.
- **Should unnecessary duplicate workload still be avoided where
  cheap?** Yes — not because duplicates are unsafe, but because it's
  free to reduce them. Two guards, at zero new privilege:
  1. **Re-check freshness immediately before dispatching**, not against
     a value cached from earlier in the same Cron invocation — trivial,
     since the whole check-then-dispatch sequence happens in one
     `scheduled()` invocation lasting well under a second of wall time
     against R2.
  2. **Optionally check whether a run is already `in_progress`/`queued`**
     for this workflow via `GET /repos/{owner}/{repo}/actions/workflows/{id}/runs?status=in_progress`
     before dispatching — this repository is **public**, so this read
     can be done fully unauthenticated (no credential needed at all for
     this specific check), skipping the dispatch if a run is already
     underway. This is a nice-to-have optimization, not a correctness
     requirement, given duplicates are already proven harmless above.
- **Could a race cancel an in-progress legitimate backup?** No — nothing
  proposed here ever calls `cancel-in-progress`, sets it to `true`, or
  touches the existing concurrency group's semantics in any way.

---

## 9. Watchdog state machine

Pure, deterministic, and — per this repository's own established
convention (e.g. `freshnessStatus`/`pipelineStatusCheck` in
`lib/data-health/model.ts`, `resolveAttentionType` in
`lib/portfolio-focus/`) — intended to be written as a small, unit-
testable pure function taking `(status, now)` and returning a decision,
separate from the thin I/O shell (R2 read, GitHub API call) that calls
it. No implementation is included in this investigation round; this is
the logic that a future implementation round would build:

```
1. Read backup-latest-success.json and backup-latest-attempt.json
   from the status bucket (existing read-only binding).
2. Compute ageMs = now - successDate (or "no success ever recorded").
3. If ageMs < RECOVERY_THRESHOLD_MS (26h) AND no newer failed attempt:
      -> "fresh" -- exit, no action, log nothing beyond routine trace.
4. If ageMs >= RECOVERY_THRESHOLD_MS (or a newer attempt recorded failure):
      a. (Optional, zero-privilege) Check whether a run is already
         in_progress/queued for the backup workflow; if so, exit
         "already-recovering", no dispatch.
      b. Re-read status once more (guard against a race where the
         scheduled run completed between step 1 and now).
      c. If still stale: call workflow_dispatch. Record the action
         (Cloudflare Workers structured log: which threshold crossed,
         ageMs, whether dispatch succeeded) via the existing
         `observability: enabled: true` Workers Logs -- no new storage
         needed for Stage 1/2.
      d. If dispatch itself fails (GitHub API error, rate limit,
         network): log the failure. Do NOT retry within the same
         invocation -- the next hourly invocation naturally retries,
         since staleness persists until a new success is recorded.
5. On every subsequent hourly invocation, re-run steps 1-4 from
   scratch -- there is no persistent "did I already try" state to get
   out of sync, by design. If a dispatch from a prior hour succeeded,
   the next invocation's freshness read will show it and naturally
   return to "fresh."
6. Escalate (Section 10) only when ageMs crosses the EXISTING 36h
   ("attention") threshold -- i.e., only once the watchdog has had a
   full recovery window (26h -> 36h = 10h, ample time for a ~30-second
   job to run) and staleness still persists. This is what turns
   "recovery dispatch didn't work" into a human-visible signal, rather
   than silently retrying forever.
```

**No silent infinite retry loop:** each hourly invocation is a fresh,
idempotent check — there is no counter, no backoff state, no possibility
of a runaway loop, because the *only* thing that ever stops the
"dispatch again next hour" behavior is either (a) a fresh success
appearing in the status bucket, or (b) the operator manually
intervening once escalation (Section 10) fires. Re-dispatching hourly
while genuinely stale is exactly the desired behavior, not a bug — each
such dispatch is cheap (Section 8) and each is a fresh, independent
attempt to self-heal.

---

## 10. Alerting recommendation

**Investigated existing channels in this codebase** (rather than
inventing a new one):

- **Workspace Health** — already shows backup freshness passively;
  requires a human to look. Necessary but, per the task's own framing,
  not sufficient alone.
- **GitHub Issue/Actions-failure notifications** — this repository has
  no evidence of configured Actions-failure notification routing
  beyond GitHub's own default (which, notably, would not even fire for
  the actual problem here, since every run that *does* execute
  succeeds — there is no failed *run* to notify about, only an absent
  one, which GitHub has no notification mechanism for at all).
- **Email, via the existing Daily Fundraising Agenda's Gmail pipeline**
  (`lib/agenda/gmail-client.ts`, already OAuth-configured, already
  sending real mail to the workspace owner daily) — **this is the
  highest-signal, lowest-new-surface option available.**

**Recommendation:** extend the *existing* hourly `scheduled()` handler
already running in the main application Worker (the same one that
already gates the Daily Agenda send) with one more cheap, guarded
check: once per day (not once per hour — avoid alert fatigue), read
backup status via the **already-existing** `STATUS_WORKER` service
binding (zero new credential, zero new binding — this is exactly the
same read path Workspace Health's own server-rendered check already
uses), and if age has crossed the **existing** 36h "attention"
threshold, send one email via the **already-existing** Gmail pipeline.

This deliberately keeps the two new capabilities on opposite sides of
the existing isolation boundary: the GitHub-dispatch credential lives
only on `status-worker` (Section 6); the email-sending credential
already lives only on the main app Worker and never needs to move.
Neither Worker gains a capability that crosses into the other's
territory.

**Avoid alerting on the cron itself being late.** A 30-minute delay is
normal and observed daily; alerting on that would be pure noise
(exactly what the task warns against). The alert fires only at the
36h **escalation** tier defined in Section 2 — meaning, by definition,
the automated recovery dispatch has *already* had a 10-hour window to
self-heal and failed to. That is a rare, genuinely actionable event,
which is exactly the bar for "prefer a small number of high-signal
alerts."

---

## 11. Dashboard semantics recommendation

The existing "Automated backup" card (`lib/data-health/model.ts`,
`pipelineStatusCheck`) already does more than the task's framing gives
it credit for: it is **not** a static green check — it already computes
age-based `healthy`/`attention`/`critical` status, and already floors
the status at `attention` the moment a newer attempt is known to have
failed, even while the last *success* is still numerically fresh. This
is a real, working answer to "the system should not show a green check
indefinitely."

**What it does not yet distinguish, and should, once a watchdog
exists:**

| Recommended new state | When | Not implemented in this round |
|---|---|---|
| **Healthy** | age < 26h | Already exists (as "healthy") |
| **Delayed** | age 26h–36h, watchdog has dispatched a recovery run that hasn't completed/reported yet | New — currently indistinguishable from plain "healthy" until 36h |
| **Recovery triggered** | Same window, watchdog action specifically recorded | New — requires the watchdog to publish *something*, even a minimal marker |
| **Stale — action required** | age ≥ 36h (existing "attention"/"critical", now meaning "watchdog also failed") | Already exists as "attention"/"critical"; recommend re-labeling its *explanation text* once a watchdog exists, so it reads "the automated recovery also failed" rather than merely "the last successful run was longer ago than expected" |

Implementing "Delayed"/"Recovery triggered" requires the watchdog to
**write**, not just read, a small status object — a real, if small,
scope increase for `status-worker` beyond Stage 1/2 (Section 12). This
document recommends it as a **future enhancement, explicitly out of
scope for the initial reliability fix** (Section 15's open risks),
since the core problem (silent multi-hour/day gaps) is fully solved by
Sections 9–10 without it.

---

## 12. Timezone / daily semantics

**Recommendation: operational freshness (a rolling window measured in
elapsed hours since the last verified success), not a calendar-day
rule of either kind.**

- The existing dashboard logic already computes `now - successDate.getTime()`
  — a pure elapsed-time calculation, immune to calendar/timezone edge
  cases by construction. This investigation ratifies that choice rather
  than replacing it.
- A "one per Eastern calendar day" or "one per UTC calendar day" rule
  would need to special-case both the **DST transition** (America/New_York
  shifts UTC offset by exactly 1 hour twice a year — a UTC-anchored
  cron at `0 8 * * *` never itself moves, but its *local* wall-clock
  time drifts from 4:00 AM EDT (UTC−4) to effectively 3:00 AM EST
  (UTC−5) across the fall transition, and back in spring) and the
  **midnight-boundary problem** (a backup completing at 23:58 UTC one
  day and the next at 00:05 UTC the next would satisfy neither a strict
  "one per calendar day" rule cleanly nor represent any real gap in
  protection).
- A rolling freshness window sidesteps both: it only ever asks "how
  long has it actually been," which is what genuinely matters for
  disaster-recovery exposure, and requires zero DST-awareness or
  calendar-boundary logic anywhere in the watchdog.

---

## 13. Restore verification remains separate (confirmed, unchanged)

- `d1-restore-verify-monthly.yml`'s entire run history (10 runs, all
  `workflow_dispatch`) is from the same Aug 16–18 initial-setup window
  as the backup pipeline's manual test runs — **it has not yet had its
  first real `schedule`-triggered firing** (next due 2026-09-01T09:00Z).
  This is expected and not a problem: the monthly cadence means the
  first scheduled run simply hasn't come due yet.
- This is deliberately **not** analyzed, redesigned, or touched further
  in this investigation, per the task's explicit instruction. The
  watchdog proposed here protects **backup freshness only**. A stale
  restore-verification date is a separate, already-modeled concern
  (`restoreVerificationCheck`, unchanged) with its own 40-day/60-day
  thresholds, not conflated with the 26h/36h/72h backup-freshness tiers
  above.

---

## 14. Recommended architecture (one, specific, chosen)

**Option B, refined: a Cloudflare Cron Trigger added to `status-worker`
(not the main application Worker), reusing this repository's own
already-proven hourly-guarded-`scheduled()`-handler pattern.**

The task's starting hypothesis ("keep the backup in GitHub Actions, add
an independent Cloudflare Cron watchdog") is **correct and adopted**,
challenged and confirmed rather than rejected — Section 5's analysis
found no common-mode failure between Cloudflare Cron and GitHub's
scheduler, and Sections 3–4 found no viable alternative that improves
on it. The one refinement this investigation adds beyond the stated
hypothesis: **which Worker hosts it.**

**Why `status-worker`, not `worker/index.ts` (the main app):**

- `status-worker` already exists specifically as the backup pipeline's
  own isolated, minimal, non-user-facing operational infrastructure —
  adding one narrow new capability to it (a GitHub dispatch credential)
  keeps that capability entirely out of the Worker that serves real
  users and real donor data.
- It already has exactly the read access the freshness check needs
  (`STATUS_BUCKET`), with zero grant required.
- It currently has zero outbound network calls of any kind (pure R2
  read + JSON response) — adding one outbound call (to GitHub's API,
  only when stale) is a small, auditable, easily-reasoned-about change
  to a Worker whose entire codebase is ~70 lines.
- The main application Worker gains **nothing** from this change: no
  new secret, no new binding, no new behavior. Its existing hourly
  `scheduled()` handler is reused only for **alerting** (Section 10),
  which needs the Gmail credential it already has and nothing new.

**Evaluated against the task's own criteria:**

| Criterion | Assessment |
|---|---|
| True independence from GitHub scheduler delay | Yes (Section 5) |
| Minimal security privilege | Yes — one new, narrowly-scoped-to-one-permission-on-one-repo credential, isolated on the one Worker already built for backup-adjacent concerns (Section 6) |
| Reuse of proven backup mechanics | Total — the real export/encrypt/upload pipeline is untouched; only *triggering* it gains a second path |
| Low operational complexity | Yes — reuses an existing Cron Trigger *pattern* (new trigger, same shape as the Daily Agenda's), existing status bucket, existing service-binding-based alerting path |
| Race safety | Yes (Section 8) — duplicates are proven harmless, and cheap mitigations exist |
| Clear observability | Yes (Section 9's logging + Section 11's dashboard-recommendation path) |
| Low cost | Yes — one Cloudflare Cron Trigger invocation per hour (well within any Workers free/paid tier), no new paid service |
| Maintainability | Yes — the decision logic is a pure function, unit-testable exactly like this codebase's existing `freshnessStatus`/`resolveAttentionType` pattern |

---

## 15. Staged implementation plan (smallest viable, for a future round)

### Stage 1 — Detection only, no dispatch, no new credential

- **Files/services:** `status-worker/wrangler.jsonc` (add
  `"triggers": {"crons": [...]}`), `status-worker/src/index.ts` (add a
  `scheduled()` export implementing Section 9 steps 1–3 only — compute
  and log the freshness tier; never call GitHub).
- **Secrets/permissions:** none. No new binding, no new secret — this
  stage only reads the existing `STATUS_BUCKET`.
- **Failure behavior:** a failed R2 read or malformed JSON logs an
  error and exits; never throws in a way that could affect the
  Worker's existing `/status` fetch handler (separate code path).
- **Tests:** the pure freshness-decision function, unit-tested against
  synthetic status JSON fixtures (fresh / stale-attention / stale-critical
  / missing success / missing attempt / newer-failed-attempt / malformed
  JSON) — no live network or R2 needed for these.
- **Deployment target:** Independent Staging's `status-worker` only
  (`cd status-worker && wrangler deploy`), same as its existing deploy
  path. No change to the main app.
- **Rollback:** remove the `triggers` block and redeploy — the Worker
  reverts to fetch-only, exactly as it is today. No data or state to
  unwind, since this stage writes nothing anywhere.

### Stage 2 — Auto-dispatch on confirmed staleness

- **Files/services:** `status-worker/src/index.ts` (extend the
  `scheduled()` handler with Section 9 steps 4–5: dispatch via GitHub's
  API when stale).
- **Secrets/permissions:** **one new secret** — a fine-grained GitHub
  PAT, repository-scoped to this repo only, "Actions: Read and write,"
  no other permission — stored as a `status-worker` Cloudflare secret
  (`wrangler secret put`), never as a repository/GitHub secret and
  never on the main app Worker.
- **Failure behavior:** a failed dispatch call (network error, GitHub
  API error, expired/revoked token) is logged; no retry within the same
  invocation (Section 9's "no infinite loop" design) — the next hourly
  invocation naturally re-evaluates and re-attempts if still stale.
- **Tests:** the same pure decision function, extended to assert
  *which* action it recommends (`none` / `dispatch` / `escalate`)
  under each fixture from Stage 1's list plus: dispatch call fails,
  dispatch call succeeds, a run is already in-progress (Section 8's
  optional check), freshness re-checked immediately before dispatch
  shows it's already recovered (no dispatch after all). The actual
  GitHub API call is isolated behind a small interface so these remain
  pure/offline tests, matching this codebase's established
  `lib/portfolio-focus`/`lib/data-health` convention of separating pure
  decision logic from I/O.
- **Deployment target:** Independent Staging's `status-worker`.
- **Rollback:** revert the `scheduled()` handler to Stage 1's
  detect-only version (or remove the cron trigger entirely, reverting
  to Stage 0) and redeploy; delete the Cloudflare secret if fully
  rolling back. The GitHub PAT can be revoked independently at any time
  without touching any Cloudflare deployment.

### Stage 3 — Active alerting if recovery still fails

- **Files/services:** `worker/index.ts` / `lib/agenda/` (extend the
  *existing* hourly `scheduled()` handler with a once-per-day guarded
  check, reusing the existing `STATUS_WORKER` service binding and the
  existing Gmail-sending pipeline).
- **Secrets/permissions:** none new — reuses the Gmail credential
  already configured for the Daily Agenda.
- **Failure behavior:** if the Gmail send itself fails, log it; do not
  let an alerting failure affect the Daily Agenda's own unrelated send
  logic (separate guarded branch, not a shared code path).
- **Tests:** the once-per-day guard (mirroring
  `isDailyAgendaSendHour()`'s own existing test coverage style), and
  the escalation-threshold decision (send only at ≥36h, matching
  Section 2's existing constant — reuse `BACKUP_FRESHNESS_HEALTHY_MS`
  directly rather than a new hardcoded number).
- **Deployment target:** the main app Worker
  (`fundraising-os-staging`), via the existing deploy path.
- **Rollback:** remove the new guarded branch and redeploy; no new
  secret to unwind.

**Section 11's dashboard-semantics enhancement (Delayed / Recovery
triggered states) is deliberately not a numbered stage above** — it
requires `status-worker` to gain write access to its own status bucket
(a real, if small, scope increase beyond Stages 1–2), and the core
reliability problem is fully solved without it. Recommended as a
follow-up round, not a blocker.

---

## 16. Test plan

All scenarios below target the **pure decision function** (Section 9)
first, with I/O (R2 read, GitHub API call) isolated behind a thin
interface exactly as this codebase already does for
`lib/portfolio-focus/data.ts` vs. its pure siblings — matching the
project's own established pure-logic/thin-I/O-shell convention so these
run offline, fast, and deterministically:

1. **Fresh backup:** `success.completedAt` 2h old → decision `none`.
2. **Stale backup (26h+):** → decision `dispatch`, with the correct
   recovery-threshold boundary tested at exactly 26h and just under it.
3. **Delayed scheduled run already in progress:** GitHub API reports an
   `in_progress` run for the workflow → decision `none` (skip,
   already recovering) even though age is stale.
4. **Scheduled run begins at the same moment the watchdog fires:** the
   immediate freshness re-check (Section 8) observes the new success
   before dispatching → decision `none`.
5. **Dispatch call fails** (simulated network/API error) → logged,
   function returns a distinct `dispatch-failed` outcome (not silently
   treated as success), no retry attempted within the call.
6. **Dispatched backup succeeds:** next invocation's freshness read
   shows a new, recent success → decision returns to `none`.
7. **Dispatched backup fails:** the workflow's own `backup-latest-attempt.json`
   records the failure → the "attempt floors status" rule (reused from
   `lib/data-health/model.ts`) keeps the decision at `dispatch` (or
   `escalate`, once past 36h) rather than incorrectly reading the old,
   still-present `success.json` as proof of freshness.
8. **Real backup succeeds but status publication fails:** `success.json`
   is missing/stale despite this being simulated as "the real backup
   actually succeeded" — decision is still `dispatch` (per Section 7's
   accepted tradeoff), asserted as the deliberate, documented behavior,
   not a bug.
9. **Malformed/missing status JSON:** decision treats this identically
   to "never succeeded" (matching `pipelineStatusCheck`'s own existing
   "never let malformed data read as healthy" rule) → `dispatch`
   (or the appropriate never-run message), never `none`.
10. **GitHub API unavailable** (dispatch or in-progress-check call
    times out/errors): treated as scenario 5 — logged, no crash, no
    retry storm.
11. **Cloudflare Cron itself delayed:** not independently testable
    (Cloudflare's own scheduler is out of this codebase's control the
    same way GitHub's is), but the decision function's own idempotency
    (fresh check every invocation, Section 9 step 5) means a delayed
    Cron invocation is self-correcting — no test-visible failure mode,
    documented as an accepted residual risk (Section 17).
12. **DST transition:** assert the decision function's math is a pure
    millisecond subtraction with no timezone-aware date parsing
    anywhere in the freshness calculation — a fixture straddling a
    UTC offset change (e.g. `successDate` before a DST boundary,
    `now` after it) produces the same `ageMs` as an equivalent
    non-boundary-straddling pair the same number of real hours apart.
13. **Duplicate watchdog execution** (two invocations overlapping,
    e.g. a slow Cron tick plus a manual re-trigger during testing):
    both independently re-read fresh state; the second one's dispatch
    is naturally suppressed by whichever of scenarios 3/4 applies once
    the first's dispatch has landed — no shared mutable state between
    invocations to race on, since each invocation is a fresh read.
14. **Concurrency safety at the real GitHub Actions layer:** already
    verified analytically in Section 8 against the real, existing
    `concurrency:` block — no new workflow-level test is needed since
    no workflow YAML changes in this plan; a future round could add an
    integration-style check (two manual dispatches in quick succession
    both eventually appear in run history as separate, non-cancelled
    runs) if desired.

---

## 17. Open risks / not resolved here

- **Section 11's dashboard-semantics enhancement** (distinguishing
  "Delayed"/"Recovery triggered" from plain "Healthy") requires a
  small write-access scope increase for `status-worker` not undertaken
  in the staged plan above. Recommended as a distinct future round with
  its own explicit approval, not folded in here.
- **Cloudflare Cron Trigger reliability itself** is not independently
  audited in this investigation beyond noting it is a different
  platform from GitHub's — if Cloudflare's own Cron infrastructure
  degrades, the watchdog simply doesn't run that hour; the *primary*
  backup is unaffected (Section 5), but this document does not attempt
  to bound Cloudflare Cron's own worst-case delay the way Section 1
  bounded GitHub's, since no comparable incident has been observed to
  investigate.
- **The fine-grained PAT's expiration** — GitHub fine-grained PATs can
  be set to expire (up to 1 year, or no expiration for org-owned
  tokens depending on org policy); a future implementation round should
  set a reasonable expiration and a calendar reminder to rotate it,
  since an *expired* dispatch credential would silently degrade the
  watchdog back to "detection only" (Stage 1 behavior) without loudly
  failing — worth an explicit freshness-of-the-credential-itself check
  in a later hardening pass, not designed here.
- **Today's (Aug 28) actual outcome is still unknown** as of this
  report (15:25 UTC) — this investigation deliberately did not dispatch
  a corrective run (explicitly out of scope), so whether Aug 28's
  scheduled run eventually fires late or never fires at all remains
  to be seen by whoever next checks Workspace Health or the Actions
  tab.

---

**Stopping here, per explicit instruction.** No workflow YAML, Cloudflare
configuration, Cloudflare Cron trigger, GitHub secret, R2 bucket/binding,
backup encryption, Worker code, or production/main content was changed.
No backup was dispatched. No data was mutated. Investigation and design
only.
