// The virtual module cloudflare-workers-shim-loader.mjs resolves
// "cloudflare:workers" to. `env` is a plain mutable object -- a test
// sets `env.DB = someD1SqliteAdapter` (and any other binding a given
// production module happens to read) before invoking the real code.
export const env = {};
