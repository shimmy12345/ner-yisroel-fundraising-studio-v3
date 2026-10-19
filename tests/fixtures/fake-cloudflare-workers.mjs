// Stands in for the real "cloudflare:workers" module's `env` export --
// see cloudflare-workers-loader.mjs's own header. A single mutable
// object a test mutates in place (`env.DB = ...`) before dynamically
// importing lib/relationships/trips-data.ts, which reads from this exact
// same object reference at call time.
export const env = {};
