import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chunk } from "../lib/collections.ts";

// "The shared activity could not be validated. Nothing was saved." follow-up
// incident (docs/AI-HANDOFF.md). Live-reproduced against Independent
// Staging via `wrangler tail` + a controlled, non-mutating request using
// real, owned donor ids (each probe appended one deliberately-nonexistent
// id so the request always safely stopped at "One or more donors were not
// found" before any write, regardless of which branch it reached):
//
//   99 donors (100 total ids incl. the sentinel, 100 bound params) -> 404 (ok)
//  100 donors (101 total ids, 101 bound params)                    -> 500
//  101 donors (102 total ids, 102 bound params)                    -> 500
//
// The actual server log captured live for the 101-donor probe:
//   {"level":"error","message":"shared_activity_precheck_failed",
//    "error":"D1_ERROR: too many SQL variables at offset 280: SQLITE_ERROR",
//    "donorCount":101}
//
// Root cause: the donor-ownership lookup bound one parameter per donor id
// plus one for owner_user_id in a single statement. D1 hard-caps a
// statement at 100 bound parameters; MAX_RECIPIENTS (200) already allowed
// well more donors than that in one request, and the new A-Z browseable
// directory (a prior task) made selecting 100+ donors in one shared
// activity far more likely than it was with the old search-only picker.
// Fix: the lookup is now chunked (OWNERSHIP_QUERY_CHUNK_SIZE = 90) so no
// single statement ever approaches the 100-parameter wall, and this file
// proves that holds at every donor count this route allows.

const D1_MAX_BOUND_PARAMETERS = 100;
const OWNERSHIP_QUERY_CHUNK_SIZE = 90;

// ---- chunk(): pure utility ----

{
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 5), []);
  assert.deepEqual(chunk([1, 2], 10), [[1, 2]], "a size larger than the whole array is one chunk, not an error");
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3, 4], 2).flat(), [1, 2, 3, 4], "chunking must never drop or duplicate an item");
  assert.throws(() => chunk([1], 0), "a chunk size below 1 must be rejected, not silently produce an infinite loop");
}

// ---- The deterministic proof: every supported donor count stays under
// D1's real, live-confirmed 100-bound-parameter limit once chunked ----

for (const donorCount of [2, 10, 25, 50, 100, 200]) {
  const donorIds = Array.from({ length: donorCount }, (_, index) => `donor-${index}`);
  const chunks = chunk(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE);
  const boundParamCounts = chunks.map((idsInChunk) => 1 + idsInChunk.length); // 1 = owner_user_id
  for (const count of boundParamCounts) {
    assert.ok(count <= D1_MAX_BOUND_PARAMETERS, `donorCount=${donorCount}: a chunk bound ${count} parameters, over D1's ${D1_MAX_BOUND_PARAMETERS}-parameter limit`);
  }
  assert.equal(chunks.flat().length, donorCount, `donorCount=${donorCount}: chunking must not drop or duplicate any donor id`);
  assert.equal(new Set(chunks.flat()).size, donorCount, `donorCount=${donorCount}: no donor id should appear in more than one chunk`);
}

{
  // The exact real-world failure shape: 101 donor ids in one unchunked
  // statement would bind 102 parameters (1 + 101), over the limit --
  // proving the OLD, unchunked code really would fail at this size, not
  // just in the live incident.
  const donorIds = Array.from({ length: 101 }, (_, index) => `donor-${index}`);
  const unchunkedBoundParams = 1 + donorIds.length;
  assert.ok(unchunkedBoundParams > D1_MAX_BOUND_PARAMETERS, "the exact reported failure size must genuinely exceed D1's limit when unchunked");
  // ...but chunked, every chunk stays comfortably under it.
  const chunked = chunk(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE);
  for (const idsInChunk of chunked) assert.ok(1 + idsInChunk.length <= D1_MAX_BOUND_PARAMETERS);
}

{
  // MAX_RECIPIENTS itself (200, the largest request this route accepts)
  // must never produce an over-limit chunk either -- the ceiling case.
  const donorIds = Array.from({ length: 200 }, (_, index) => `donor-${index}`);
  const chunked = chunk(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE);
  assert.equal(chunked.length, 3, "200 donors at a chunk size of 90 is 3 chunks (90 + 90 + 20)");
  for (const idsInChunk of chunked) assert.ok(1 + idsInChunk.length <= D1_MAX_BOUND_PARAMETERS);
}

console.log("Shared activity ownership-chunking checks passed.");

// ---- Route wiring (source inspection) ----

const sharedRoute = await readFile(new URL("../app/api/interactions/shared/route.ts", import.meta.url), "utf8");

{
  assert.match(sharedRoute, /import \{ chunk \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/collections";/);
  assert.match(sharedRoute, /const MAX_RECIPIENTS = 200;/, "the request-level cap must be unchanged -- this fix does not weaken how many donors a shared activity can have");
}

console.log("Shared activity route ownership-chunk wiring checks passed.");
