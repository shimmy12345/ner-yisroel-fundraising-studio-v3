import assert from "node:assert/strict";
import test from "node:test";
import statusWorker from "../status-worker/src/index.ts";

function mockBucket(objects) {
  return {
    async get(key) {
      const value = objects[key];
      if (value === undefined) return null;
      if (value instanceof Error) throw value;
      return { async text() { return value; } };
    },
  };
}

const SUCCESS_JSON = JSON.stringify({ schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: "2026-08-17T04:00:00.000Z", backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://example/actions/runs/1" });

test("GET /status returns all four objects, combined, when every key exists", async () => {
  const env = { STATUS_BUCKET: mockBucket({
    "backup-latest-success.json": SUCCESS_JSON,
    "backup-latest-attempt.json": JSON.stringify({ schemaVersion: 1, attemptStatus: "success" }),
    "restore-latest-success.json": JSON.stringify({ schemaVersion: 1, verifiedBackupObjectKey: "latest/x.sql.gz.gpg" }),
    "restore-latest-attempt.json": JSON.stringify({ schemaVersion: 1, attemptStatus: "success" }),
  }) };
  const response = await statusWorker.fetch(new Request("https://status-worker.internal/status"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.backup.success.databaseName, "fundraising-os-staging-db");
  assert.equal(body.backup.attempt.attemptStatus, "success");
  assert.equal(body.restore.success.verifiedBackupObjectKey, "latest/x.sql.gz.gpg");
  assert.equal(body.restore.attempt.attemptStatus, "success");
  assert.deepEqual(body.readErrors, []);
});

test("GET /status returns null (not an error, not a crash) for objects that don't exist yet", async () => {
  const env = { STATUS_BUCKET: mockBucket({}) };
  const response = await statusWorker.fetch(new Request("https://status-worker.internal/status"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { backup: { success: null, attempt: null }, restore: { success: null, attempt: null }, readErrors: [] });
});

test("a malformed (non-JSON) object is reported in readErrors, not silently treated as absent or crashing the whole response", async () => {
  const env = { STATUS_BUCKET: mockBucket({ "backup-latest-success.json": "not valid json {{{" }) };
  const response = await statusWorker.fetch(new Request("https://status-worker.internal/status"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.backup.success, null);
  assert.equal(body.readErrors.length, 1);
  assert.match(body.readErrors[0], /backup-latest-success\.json/);
  assert.match(body.readErrors[0], /not valid JSON/);
});

test("an R2 read failure for one key is reported in readErrors without affecting the other three", async () => {
  const env = { STATUS_BUCKET: mockBucket({
    "backup-latest-success.json": new Error("R2 unavailable"),
    "restore-latest-success.json": SUCCESS_JSON,
  }) };
  const response = await statusWorker.fetch(new Request("https://status-worker.internal/status"), env);
  const body = await response.json();
  assert.equal(body.backup.success, null);
  assert.equal(body.restore.success.databaseName, "fundraising-os-staging-db");
  assert.equal(body.readErrors.length, 1);
  assert.match(body.readErrors[0], /backup-latest-success\.json/);
  assert.match(body.readErrors[0], /R2 unavailable/);
});

test("any path other than exactly /status returns 404, never a passthrough to an arbitrary key", async () => {
  const bucket = mockBucket({ "backup-latest-success.json": SUCCESS_JSON, "some-other-key.json": "{}" });
  let getCalls = 0;
  const trackedBucket = { async get(key) { getCalls++; return bucket.get(key); } };
  const env = { STATUS_BUCKET: trackedBucket };
  for (const path of ["/", "/status/", "/status/backup-latest-success.json", "/some-other-key.json"]) {
    const response = await statusWorker.fetch(new Request(`https://status-worker.internal${path}`), env);
    assert.equal(response.status, 404, `path ${path} must 404`);
  }
  assert.equal(getCalls, 0, "R2 must never be touched for a request outside the one fixed /status route");
});

test("non-GET methods are rejected with 405 before touching R2", async () => {
  const env = { STATUS_BUCKET: mockBucket({}) };
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await statusWorker.fetch(new Request("https://status-worker.internal/status", { method }), env);
    assert.equal(response.status, 405);
  }
});

test("the response is never cached (cache-control: no-store), so status is never served stale from an intermediate cache", async () => {
  const env = { STATUS_BUCKET: mockBucket({}) };
  const response = await statusWorker.fetch(new Request("https://status-worker.internal/status"), env);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

process.stdout.write("Status-worker checks passed.\n");
