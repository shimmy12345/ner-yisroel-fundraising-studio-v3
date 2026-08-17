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
