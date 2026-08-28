import assert from "node:assert/strict";
import { checkActiveBackupRun, dispatchBackupWorkflow } from "../status-worker/src/github-dispatch.ts";

// Backup watchdog -- GitHub API client tests (docs/BACKUP-SCHEDULING-
// RELIABILITY.md Section 18). Every test injects a fake `fetch`, never a
// real network call, per this repo's own "tests must not depend on the
// network" convention (see tests/backup-automation.test.mjs's own
// source-inspection-only approach for the workflows this exercises).

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

// ---- dispatchBackupWorkflow ----

{
  const calls = [];
  const fetchImpl = fakeFetch((url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  const result = await dispatchBackupWorkflow(fetchImpl, "secret-token-value");
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/shimmy12345\/ner-yisroel-fundraising-studio-v3\/actions\/workflows\/d1-backup-nightly\.yml\/dispatches$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token-value");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main" });
}

for (const status of [401, 403, 404]) {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ message: "nope" }), { status }));
  const result = await dispatchBackupWorkflow(fetchImpl, "token");
  assert.equal(result.ok, false, `HTTP ${status} must be reported as a failed dispatch, never silently treated as success`);
  assert.equal(result.status, status);
}

{
  const fetchImpl = fakeFetch(() => new Response("Internal Server Error", { status: 502 }));
  const result = await dispatchBackupWorkflow(fetchImpl, "token");
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
}

{
  const fetchImpl = fakeFetch(() => { throw new Error("network timeout"); });
  const result = await dispatchBackupWorkflow(fetchImpl, "token");
  assert.equal(result.ok, false, "a thrown network error must be caught and reported, never propagate uncaught");
  assert.equal(result.status, null);
  assert.match(result.error, /network timeout/);
}

// ---- checkActiveBackupRun ----

{
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ workflow_runs: [{ status: "completed" }, { status: "in_progress" }] }), { status: 200 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.deepEqual(result, { hasActiveRun: true });
}

{
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ workflow_runs: [{ status: "completed" }, { status: "completed" }] }), { status: 200 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.deepEqual(result, { hasActiveRun: false });
}

{
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ workflow_runs: [{ status: "queued" }] }), { status: 200 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.equal(result.hasActiveRun, true, "a queued (not yet in_progress) run must also count as active");
}

{
  const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.equal(result.hasActiveRun, null, "a malformed GitHub response must never be read as a known false");
  assert.ok(typeof result.error === "string" && result.error.length > 0);
}

{
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ notWorkflowRuns: [] }), { status: 200 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.equal(result.hasActiveRun, null, "a response shaped unexpectedly (missing workflow_runs) must never be read as a known false");
}

{
  const fetchImpl = fakeFetch(() => new Response("rate limited", { status: 403 }));
  const result = await checkActiveBackupRun(fetchImpl);
  assert.equal(result.hasActiveRun, null, "a non-2xx response must be treated as unknown, never as false");
}

{
  const fetchImpl = fakeFetch(() => { throw new TypeError("fetch failed"); });
  const result = await checkActiveBackupRun(fetchImpl);
  assert.equal(result.hasActiveRun, null);
  assert.match(result.error, /fetch failed/);
}

// The active-run check must never send the dispatch token -- it is
// intentionally unauthenticated (this repository is public).
{
  const fetchImpl = fakeFetch((_url, init) => {
    assert.ok(!init?.headers?.authorization, "checkActiveBackupRun must never send an Authorization header");
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  });
  await checkActiveBackupRun(fetchImpl);
}

process.stdout.write("Backup watchdog GitHub-client checks passed.\n");
