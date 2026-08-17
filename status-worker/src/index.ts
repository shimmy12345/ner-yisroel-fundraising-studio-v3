// Minimal, dedicated status Worker for the D1 backup/restore-verification
// pipeline. This Worker exists ONLY to answer "GET /status" with four
// fixed, non-secret JSON objects read from a bucket that contains status
// metadata alone -- never backup data, never credentials.
//
// Isolation properties, all load-bearing (see tests/status-worker.test.mjs):
//   - Its R2 binding points at the STATUS bucket only. It has no binding,
//     credential, or code path that can reach the real backup bucket
//     (fundraising-os-staging-backups) at all.
//   - It never calls R2's list/delete/put APIs -- read-only .get() on
//     four hardcoded keys, nothing derived from request input.
//   - It has no public route (see wrangler.jsonc: no `routes`,
//     `workers_dev: false`). It is reachable only via a Cloudflare Worker
//     Service Binding from another Worker explicitly configured to call
//     it -- there is no public URL to secure, so no authentication
//     scheme is needed or implemented here.
//   - Any path other than exactly "/status", or any method other than
//     GET, is rejected before touching R2 at all.

export interface Env {
  STATUS_BUCKET: R2Bucket;
}

const STATUS_KEYS = {
  backupSuccess: "backup-latest-success.json",
  backupAttempt: "backup-latest-attempt.json",
  restoreSuccess: "restore-latest-success.json",
  restoreAttempt: "restore-latest-attempt.json",
} as const;

async function readStatusObject(bucket: R2Bucket, key: string): Promise<{ value: unknown; error: string | null }> {
  try {
    const object = await bucket.get(key);
    if (!object) return { value: null, error: null };
    const text = await object.text();
    try {
      return { value: JSON.parse(text), error: null };
    } catch {
      return { value: null, error: `${key}: object exists but is not valid JSON` };
    }
  } catch (cause) {
    return { value: null, error: `${key}: read failed (${cause instanceof Error ? cause.message : "unknown error"})` };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/status") return new Response("Not found", { status: 404 });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });

    const [backupSuccess, backupAttempt, restoreSuccess, restoreAttempt] = await Promise.all([
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.backupSuccess),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.backupAttempt),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.restoreSuccess),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.restoreAttempt),
    ]);

    const readErrors = [backupSuccess.error, backupAttempt.error, restoreSuccess.error, restoreAttempt.error].filter((error): error is string => error !== null);

    return Response.json(
      {
        backup: { success: backupSuccess.value, attempt: backupAttempt.value },
        restore: { success: restoreSuccess.value, attempt: restoreAttempt.value },
        readErrors,
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
};
