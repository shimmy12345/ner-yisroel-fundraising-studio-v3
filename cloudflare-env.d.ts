interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

// Minimal shape of Cloudflare's Workers AI binding -- only the one method
// this app calls (lib/meeting-notes/providers/workers-ai.ts). Hand-rolled
// rather than pulled from @cloudflare/workers-types, matching this file's
// own D1Database/Fetcher convention above.
interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

// D1Result's `meta.changes` is what every CAS-style write in
// lib/calendar/d1-calendar-store.ts checks to tell "this exact row
// matched and was written" apart from "the WHERE guard matched nothing"
// -- D1 has no cross-statement transaction (no BEGIN/COMMIT, no
// `transaction()` method; `db.batch()` is the only atomic multi-
// statement primitive, and it cannot branch on an earlier statement's
// own result), so every compare-and-swap in that adapter is a single
// guarded UPDATE/INSERT...WHERE, never a read-then-decide-then-write
// sequence -- `meta.changes` is the only signal available for "did my
// guard actually match."
interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: {
    changes: number;
    duration: number;
    last_row_id: number;
    rows_read: number;
    rows_written: number;
    served_by?: string;
  };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

declare const __FUNDRAISING_OS_COMMIT__: string | null;
// "staging" and "production" here are the legacy ChatGPT Sites
// staging/production databases. The independent Cloudflare staging
// Worker/D1 is the distinct "staging-independent" value, and the
// independent Cloudflare production Worker/D1 (infrastructure
// provisioned 2026-10-09, see docs/PRODUCTION-INFRASTRUCTURE-SETUP.md)
// is the distinct "production-independent" value — NEITHER is a
// relabeling of its same-named legacy environment. This distinction is
// load-bearing: scripts/build-production.mjs (legacy only) and
// scripts/build-production-independent.mjs (this app's own independent
// Cloudflare Production Worker) are two different, non-interchangeable
// build targets that must never be confused with each other at deploy
// time — see lib/auth/provider-selection.ts's own doc comment for why
// this ambiguity specifically mattered for authentication hardening.
declare const __FUNDRAISING_OS_ENVIRONMENT__: "staging" | "production" | "staging-independent" | "production-independent";

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    // Only present on the independent staging Worker, for Cloudflare Access
    // JWT verification. Absent on legacy ChatGPT Sites staging/production.
    TEAM_DOMAIN?: string;
    POLICY_AUD?: string;
    STAGING_OWNER_EMAIL?: string;
    // The Client ID (never the Client Secret, which Access alone checks
    // and which this Worker never sees) of the ONE Cloudflare Access
    // Service Token allowed to authenticate as STAGING_OWNER_EMAIL for
    // trusted automation (e.g. a morning-brief script) -- see
    // lib/auth/cloudflare-access.ts's AccessVerifyConfig doc comment.
    // Absent means service-token auth is simply not accepted at all, the
    // same as today. A `vars` entry, not a secret -- a Client ID alone
    // grants no access (the Client Secret does), matching this file's own
    // STAGING_OWNER_EMAIL precedent just above.
    MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID?: string;
    // The Worker's own public base URL, used to build absolute donor links
    // in the Daily Fundraising Agenda email (a scheduled handler has no
    // incoming Request to derive an origin from, unlike an HTTP route).
    // Not a secret -- this is the same public *.workers.dev URL anyone
    // could find from the Worker's own name; kept here as a `vars` entry
    // (like TEAM_DOMAIN/STAGING_OWNER_EMAIL above) rather than a hardcoded
    // string in application source, so it stays in one place if the Worker
    // is ever remapped to a custom domain. Absent on legacy ChatGPT Sites
    // staging/production and local dev.
    APP_BASE_URL?: string;
    // Independent Staging's write-guard escape hatch (lib/operations/
    // staging-write-guard.ts) -- "true" temporarily re-enables donor/
    // fundraising-data writes on the independent staging deployment for
    // an explicitly authorized testing window; absent/anything else
    // (the default, and Production's only state regardless) keeps
    // every mutating /api/** request blocked there.
    STAGING_WRITES_ENABLED?: string;
    // Gmail API send-only OAuth credentials for the Daily Fundraising
    // Agenda email (see docs/AI-HANDOFF.md's "Daily Fundraising Agenda
    // Email" section). All three are Cloudflare Worker *secrets*
    // (`wrangler secret put`), never `vars` -- they must never appear in
    // this repo, a wrangler config file, or any log line. The OAuth
    // client was registered with only the `gmail.send` scope (send-only,
    // no inbox read/modify access). Absent wherever this feature hasn't
    // been configured (legacy staging/production, local dev) -- callers
    // must treat that as "sending unavailable", never attempt a send.
    GMAIL_OAUTH_CLIENT_ID?: string;
    GMAIL_OAUTH_CLIENT_SECRET?: string;
    GMAIL_OAUTH_REFRESH_TOKEN?: string;
    // Worker-to-Worker service binding to the dedicated status-worker
    // (status-worker/) -- NOT an R2 binding. This is the only way this
    // Worker can learn the backup/restore-verification pipeline's status;
    // it has no R2 credential or binding of its own. Absent wherever the
    // status-worker has not been deployed/bound (e.g. legacy staging,
    // local dev) -- callers must treat that as "unavailable", never
    // "healthy".
    STATUS_WORKER?: Fetcher;
    // AI Meeting Notes "Organize Notes" (docs/AI-HANDOFF.md, "Voice
    // Dictation and AI Meeting Notes" / "Implement Cloudflare AI Meeting
    // Notes on Staging"). The Cloudflare Workers AI binding is the DEFAULT
    // provider (lib/meeting-notes/providers/workers-ai.ts) -- a `[ai]`
    // binding declared directly in wrangler config, like DB above, never a
    // secret. Absent means Workers AI organization is unavailable; the
    // route falls back to reporting "unavailable" rather than attempting a
    // call, same as the Anthropic case below.
    AI?: Ai;
    // A `vars` entry (not a secret) -- the Workers AI model id to use for
    // Organize Notes, configurable without a code change. Absent falls
    // back to lib/meeting-notes/providers/workers-ai.ts's own
    // DEFAULT_WORKERS_AI_MODEL.
    WORKERS_AI_MODEL?: string;
    // A `vars` entry (not a secret) -- which provider app/api/meeting-
    // notes/organize/route.ts calls: "workers-ai" (the default; also used
    // if this is absent or any other value) or "anthropic". Changing
    // providers is a config-only change, no code deploy required.
    AI_PROVIDER?: "workers-ai" | "anthropic";
    // Anthropic Claude -- kept as a configurable, currently INACTIVE
    // alternative provider (lib/meeting-notes/providers/anthropic.ts),
    // selected only if AI_PROVIDER is explicitly set to "anthropic". A
    // Cloudflare Worker *secret* (`wrangler secret put`), never a `vars`
    // entry -- must never appear in this repo, a wrangler config file, or
    // any log line. Absent on every environment as of this round, and
    // deliberately not created: this app does not require a separate
    // Anthropic account to use AI Meeting Notes. Absent means Anthropic
    // organization is unavailable (callers must treat that as
    // "unavailable", never attempt a call, and let the fundraiser save
    // notes manually instead).
    ANTHROPIC_API_KEY?: string;
    // A `vars` entry (not a secret) -- the Claude model id to use when
    // AI_PROVIDER="anthropic". Absent falls back to lib/meeting-notes/
    // providers/anthropic.ts's own DEFAULT_ANTHROPIC_MODEL.
    ANTHROPIC_MODEL?: string;
    // Google Calendar sync OAuth credentials (lib/calendar/
    // google-calendar-client.ts) -- deliberately separate secret names
    // from GMAIL_OAUTH_* above, even though both are Google OAuth client
    // credentials: the Calendar OAuth client is registered with the
    // `calendar` scope, a DIFFERENT authorization than Gmail's send-only
    // `gmail.send` grant, and the two must never be confused or
    // substituted for each other at deploy time. All three are Cloudflare
    // Worker *secrets* (`wrangler secret put`), never `vars` -- same rule
    // as GMAIL_OAUTH_* above. Absent means Calendar sync is unavailable;
    // callers must treat that as "unavailable," never attempt a call (see
    // calendar-sync-guard.ts's own `credentialsPresent` check). Not read
    // by google-calendar-client.ts itself (an explicit architectural
    // departure from gmail-client.ts, which reads `env` directly and is
    // therefore unit-testable only inside a Workers runtime) -- credentials
    // are passed in as plain parameters so that file stays testable in
    // plain Node with a mocked transport. This declaration exists so a
    // FUTURE guarded-factory call site (route/Settings/cron wiring, not
    // part of this phase -- see docs/AI-HANDOFF.md) has somewhere typed to
    // read them from.
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID?: string;
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET?: string;
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN?: string;
    // A `vars` entry (not a secret) -- the Staging-only explicit test
    // calendar id calendar-sync-guard.ts's `stagingTestCalendarId` input
    // requires before any Staging sync is ever allowed (Issue 6: "reject
    // primary/the Production destination even when the Staging opt-in is
    // enabled"). Absent means Staging sync stays refused, same as today.
    CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID?: string;
  };
}
