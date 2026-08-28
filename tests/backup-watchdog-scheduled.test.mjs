import assert from "node:assert/strict";
import { runBackupWatchdog } from "../status-worker/src/index.ts";

// Backup watchdog -- scheduled() orchestration tests
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Sections 7/9/12/13/14/15). Both
// R2 (STATUS_BUCKET) and GitHub (fetch) are injected fakes -- no live
// network or Cloudflare runtime involved, same convention as
// tests/status-worker.test.mjs's own mockBucket.

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function mockBucket(objects) {
  return {
    async get(key) {
      const value = objects[key];
      if (value === undefined) return null;
      return { async text() { return value; } };
    },
  };
}

function successJson(msAgo) {
  return JSON.stringify({ schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: iso(msAgo), backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://example/actions/runs/1" });
}

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch call: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  return { lines, restore: () => { console.log = original; } };
}

// ---- Fresh backup: no GitHub call at all, whether or not a token is configured ----
{
  const fetchImpl = fakeFetch([]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(2 * HOUR_MS) }), GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.equal(fetchImpl.calls.length, 0, "a fresh backup must never call GitHub");
  assert.equal(logs.lines.at(-1).event, "fresh");
}

// ---- Stage 1 (no token): stale backup logs recovery_needed but NEVER calls GitHub ----
{
  const fetchImpl = fakeFetch([]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(30 * HOUR_MS) }) };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.equal(fetchImpl.calls.length, 0, "Stage 1 (no GITHUB_BACKUP_DISPATCH_TOKEN) must never call GitHub, even when stale");
  assert.ok(logs.lines.some((l) => l.event === "recovery_needed_detection_only"));
}

// ---- Stage 2: stale backup, no active run, re-check still stale -> dispatch ----
{
  const fetchImpl = fakeFetch([
    new Response(JSON.stringify({ workflow_runs: [{ status: "completed" }] }), { status: 200 }), // active-run check: none active
    new Response(null, { status: 204 }), // dispatch
  ]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(30 * HOUR_MS) }), GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.equal(fetchImpl.calls.length, 2, "exactly one active-run check and one dispatch call, no more");
  assert.ok(logs.lines.some((l) => l.event === "recovery_dispatch_requested"));
  assert.doesNotMatch(JSON.stringify(logs.lines), /token/i, "the dispatch token must never appear in a log line");
}

// ---- Active run already in progress -> no dispatch ----
{
  const fetchImpl = fakeFetch([new Response(JSON.stringify({ workflow_runs: [{ status: "in_progress" }] }), { status: 200 })]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(30 * HOUR_MS) }), GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.equal(fetchImpl.calls.length, 1, "must stop after the active-run check -- no dispatch call");
  assert.ok(logs.lines.some((l) => l.event === "already_recovering"));
}

// ---- Immediate re-check before dispatch: a delayed scheduled run completed in between -> abort dispatch ----
{
  const objects = { "backup-latest-success.json": successJson(30 * HOUR_MS) };
  const fetchImpl = fakeFetch([
    new Response(JSON.stringify({ workflow_runs: [{ status: "completed" }] }), { status: 200 }), // active-run check: none active
  ]);
  // Simulate the delayed scheduled run completing between the first read
  // and the immediate re-check by mutating what the bucket returns partway
  // through -- the bucket's own .get() is re-invoked by the re-check, so
  // this is a faithful simulation of "new data appeared," not a hack
  // around the code under test.
  const bucket = mockBucket(objects);
  let getCallCount = 0;
  const originalGet = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    getCallCount += 1;
    if (key === "backup-latest-success.json" && getCallCount > 1) return { async text() { return successJson(5 * 60_000); } };
    return originalGet(key);
  };
  const env = { STATUS_BUCKET: bucket, GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.equal(fetchImpl.calls.length, 1, "must never reach the dispatch call once the re-check observes a fresh success");
  assert.ok(logs.lines.some((l) => l.event === "recovered_on_recheck"));
}

// ---- Active-run check itself fails: must proceed conservatively (never conclude healthy) ----
{
  const fetchImpl = fakeFetch([
    new Response("rate limited", { status: 403 }), // active-run check fails
    new Response(null, { status: 204 }), // dispatch still attempted
  ]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(30 * HOUR_MS) }), GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await runBackupWatchdog(env, NOW, fetchImpl);
  logs.restore();
  assert.ok(logs.lines.some((l) => l.event === "active_run_check_failed"), "a failed active-run check must be logged, not silently ignored");
  assert.ok(logs.lines.some((l) => l.event === "recovery_dispatch_requested"), "a failed active-run check must not block the dispatch attempt");
}

// ---- Dispatch call itself fails: logged, no throw, no fake success state ----
{
  const fetchImpl = fakeFetch([
    new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
    new Response("server error", { status: 500 }),
  ]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": successJson(30 * HOUR_MS) }), GITHUB_BACKUP_DISPATCH_TOKEN: "token" };
  const logs = captureLogs();
  await assert.doesNotReject(runBackupWatchdog(env, NOW, fetchImpl));
  logs.restore();
  assert.ok(logs.lines.some((l) => l.event === "recovery_dispatch_failed" && l.status === 500));
}

// ---- Missing success entirely -> recovery_needed, never crashes ----
{
  const fetchImpl = fakeFetch([]);
  const env = { STATUS_BUCKET: mockBucket({}) };
  const logs = captureLogs();
  await assert.doesNotReject(runBackupWatchdog(env, NOW, fetchImpl));
  logs.restore();
  assert.ok(logs.lines.some((l) => l.event === "recovery_needed"));
}

// ---- Malformed success JSON -> recovery_needed, never crashes ----
{
  const fetchImpl = fakeFetch([]);
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": "not valid json {{{" }) };
  const logs = captureLogs();
  await assert.doesNotReject(runBackupWatchdog(env, NOW, fetchImpl));
  logs.restore();
  assert.ok(logs.lines.some((l) => l.event === "recovery_needed"));
}

// ---- R2 read itself throwing must not crash the invocation ----
{
  const fetchImpl = fakeFetch([]);
  const env = { STATUS_BUCKET: { async get() { throw new Error("R2 unavailable"); } } };
  const logs = captureLogs();
  await assert.doesNotReject(runBackupWatchdog(env, NOW, fetchImpl));
  logs.restore();
  assert.ok(logs.lines.some((l) => l.event === "recovery_needed"), "an R2 read failure must be treated as missing status, not a crash");
}

process.stdout.write("Backup watchdog scheduled-orchestration checks passed.\n");
