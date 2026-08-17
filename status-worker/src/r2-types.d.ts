// Minimal, hand-rolled R2 typings covering only what this Worker uses
// (matches the rest of this repo's convention -- see cloudflare-env.d.ts's
// minimal D1Database/Fetcher declarations rather than pulling in the full
// @cloudflare/workers-types package). Deliberately does not declare
// put/delete/list -- this Worker never calls them, and there is no reason
// to give its own code a compile-time-typed path to do so.
interface R2Object {
  text(): Promise<string>;
}

interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
}
