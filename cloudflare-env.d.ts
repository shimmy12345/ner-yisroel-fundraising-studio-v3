interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

declare const __FUNDRAISING_OS_COMMIT__: string | null;
// "staging" here is the legacy ChatGPT Sites staging database. The
// independent Cloudflare staging Worker/D1 is the distinct "staging-independent"
// value — it is not a relabeling of the legacy environment.
declare const __FUNDRAISING_OS_ENVIRONMENT__: "staging" | "production" | "staging-independent";

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    // Only present on the independent staging Worker, for Cloudflare Access
    // JWT verification. Absent on legacy ChatGPT Sites staging/production.
    TEAM_DOMAIN?: string;
    POLICY_AUD?: string;
    STAGING_OWNER_EMAIL?: string;
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
  };
}
