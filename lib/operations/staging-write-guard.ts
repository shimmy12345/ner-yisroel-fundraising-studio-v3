// Server-side enforcement that Independent Staging defaults to
// READ-ONLY for donor/fundraising-data mutations, now that Independent
// Production is the authoritative environment (docs/AI-HANDOFF.md
// "Production Operational Transition", docs/PRODUCTION-DONOR-DATA-
// CUTOVER-EXECUTION.md). Blocks every write-method request to /api/**
// on the independent staging deployment, unless the owner has
// explicitly set STAGING_WRITES_ENABLED="true" for a deliberate,
// time-boxed testing window.
//
// Deliberately a single, blanket block of every mutating method under
// /api/**, not a curated allow/deny list of individual routes: this
// repo has 50+ API route files that create/edit/delete/merge/import
// donor or fundraising data (asks, donors, giving, imports, pledges,
// interactions, research, etc.), and a per-route list would have to be
// kept in sync by hand every time a new one is added -- exactly the
// kind of silent drift this codebase's own "fail loudly" philosophy
// (see lib/operations/workspace-backup.ts, d1-restore-order.ts) exists
// to prevent. A blanket method-based block can never miss a future
// route. The few non-donor-data mutations this also blocks (e.g.
// PUT /api/profile, POST /api/onboarding/continue) are an accepted,
// deliberate trade-off -- the STAGING_WRITES_ENABLED escape hatch
// covers them for the rare case genuine testing needs a real write.
//
// Scoped by deploymentEnvironment (lib/environment.ts), a pure,
// build-time-resolved value -- Production always resolves to
// "production-independent", a value this check never matches, so this
// can never accidentally restrict Production regardless of how
// STAGING_WRITES_ENABLED or any other var is set on that deployment.
//
// Deliberately NOT applied to the scheduled() handler's own background
// writes (lib/backup-alert/run.ts's backup_alert_state upsert): that is
// operational monitoring state, not donor/fundraising data, and should
// keep working on both environments independent of this guard.

export const STAGING_READ_ONLY_MESSAGE =
  "Staging is read-only. All live donor updates and imports must be entered in Production. (An authorized tester can set STAGING_WRITES_ENABLED=true and redeploy for a temporary testing window.)";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function isStagingWritesOverrideEnabled(stagingWritesEnabled: string | undefined): boolean {
  return stagingWritesEnabled === "true";
}

// Narrow, path-prefix-scoped exception for Trip-Based Meeting Planning
// (docs/AI-HANDOFF.md "Independent Review of Phase 2"), added so an
// authorized tester can exercise that feature on Staging without
// flipping STAGING_WRITES_ENABLED -- which would also re-open every
// donor/financial/import route this guard exists to block, exactly what
// a feature-scoped carve-out is meant to avoid.
//
// This is a single closed prefix check, not a per-route allowlist of
// the kind the header comment above already rejected for "silent
// drift" reasons: every route this feature has, or will ever have,
// lives under this one prefix by construction (app/api/trips/**), and
// no donor/financial/import route does or ever should -- confirmed by
// tests/staging-write-guard.test.mjs's own repo-wide route walk, which
// fails if that ever stops being true.
//
// Confirmed safe to exempt in full, including the meeting-scheduling/
// completion endpoints: lib/relationships/trips-data.ts never writes to
// donors, giving_activities, pledge_payment_plans, or asks. The only
// existing CRM table it touches is `interactions`, and only through a
// deterministic, trip-owned row id (trip-meeting-${prospectId}) tied to
// a real donor -- appending/idempotently upserting that one row is the
// feature's own by-design behavior an authorized tester needs to
// exercise, not an accidental side effect this guard should block.
const TRIP_PLANNING_WRITE_PATH_PREFIX = "/api/trips";

export function isTripPlanningWritePath(pathname: string): boolean {
  return pathname === TRIP_PLANNING_WRITE_PATH_PREFIX || pathname.startsWith(`${TRIP_PLANNING_WRITE_PATH_PREFIX}/`);
}

// The one function callers need: should this specific request be
// blocked as a staging-read-only write? Pure and dependency-free so it
// is trivially unit-testable without any Worker/D1/Request machinery.
export function shouldBlockStagingWrite(
  deploymentEnvironment: string,
  method: string,
  pathname: string,
  stagingWritesEnabled: string | undefined,
): boolean {
  if (deploymentEnvironment !== "staging-independent") return false;
  if (!pathname.startsWith("/api/")) return false;
  if (!isMutatingMethod(method)) return false;
  if (isStagingWritesOverrideEnabled(stagingWritesEnabled)) return false;
  if (isTripPlanningWritePath(pathname)) return false;
  return true;
}

export function stagingReadOnlyResponseInit(): ResponseInit {
  return { status: 403 };
}
