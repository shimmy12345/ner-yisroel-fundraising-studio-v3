// Pure/injectable-dependency logic for scripts/apply-0049-calendar-schema-
// repair-staging.mjs, split out so its own verification and error-
// reporting behavior can be exercised by tests/calendar-schema-repair-
// apply.test.mjs WITHOUT any D1 binding, wrangler CLI, or network access
// -- only node:sqlite (a local, built-in module) and hand-constructed
// D1-shaped plain objects. The script itself imports these functions and
// calls them against the real binding/CLI; nothing here reaches outside
// the process on its own.
import { isDeepStrictEqual } from "node:util";

export class PhaseError extends Error {
  phase: string;
  constructor(phase: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.phase = phase;
  }
}

export type Row = Record<string, unknown>;

// Confirmed in wrangler 4.92.0's own source (src/parse.ts's `APIError`
// class): a failed Cloudflare API call already carries `.status` (the
// real HTTP status code) and `.code` (Cloudflare's own numeric API
// error code, when the response included one), plus `isGatewayError()`/
// `isRetryable()` helpers wrangler itself uses to tell a platform/
// gateway problem (524, any 5xx) apart from anything else (4xx --
// typically auth/permission/not-found). This is ALREADY-EXISTING
// diagnostic output, not new instrumentation added to wrangler: the
// values are already sitting on the error object every such failure
// throws; the only gap was that this repair's own error reporting
// (describeFailure()) only ever printed `.message`, never these fields.
export type SanitizedApiErrorDetails = {
  status?: number;
  code?: number | string;
  isGatewayError?: boolean;
  isRetryable?: boolean;
  message: string;
};

// Duck-types an APIError-shaped object without importing wrangler's own
// class (this module stays dependency-free and offline-testable): any
// object with a numeric `.status` is treated as carrying real HTTP/API
// diagnostic detail. Deliberately extracts ONLY this fixed, known-safe
// field list -- never the object's own `.accountTag` (an account
// identifier wrangler itself redacts as `***` when it prints this same
// error to the console), never any header, token, or stack trace that
// could carry a request's own `Authorization` value.
function sanitizedApiErrorDetailsFrom(candidate: unknown): SanitizedApiErrorDetails | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  if (typeof value.status !== "number") return null;
  const details: SanitizedApiErrorDetails = { status: value.status, message: String((value as { message?: unknown }).message ?? "") };
  if (typeof value.code === "number" || typeof value.code === "string") details.code = value.code;
  if (typeof (value as { isGatewayError?: unknown }).isGatewayError === "function") {
    try { details.isGatewayError = Boolean((value.isGatewayError as () => unknown).call(value)); } catch { /* best-effort only */ }
  }
  if (typeof (value as { isRetryable?: unknown }).isRetryable === "function") {
    try { details.isRetryable = Boolean((value.isRetryable as () => unknown).call(value)); } catch { /* best-effort only */ }
  }
  return details;
}

// Walks an Error's own `.cause` chain (bounded depth -- this repair's
// own errors are wrapped at most a few levels deep, e.g. PhaseError ->
// "Failed to start the remote proxy session" -> the real APIError;
// wrangler's own chains are similarly shallow) looking for the first
// APIError-shaped object, since the Cloudflare API failure that
// actually matters is often wrapped by one or two of this repair's own
// (or wrangler's own) generic "X failed" errors. Returns null if none
// is found anywhere in the chain -- a real, honest "no structured API
// error was available" result, never fabricated.
export function extractApiErrorDetails(error: unknown, maxDepth = 10): SanitizedApiErrorDetails | null {
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current; depth++) {
    const details = sanitizedApiErrorDetailsFrom(current);
    if (details) return details;
    current = (current as { cause?: unknown })?.cause;
  }
  return null;
}

// Classifies a sanitized API error as most likely a permission/auth
// problem (4xx -- the token can authenticate but is not allowed to do
// this specific thing) versus most likely a platform/session problem
// (5xx, or wrangler's own isGatewayError()/isRetryable()) versus
// genuinely unclassified (no status was available at all). Never
// claims certainty beyond what the status code itself implies.
export function classifyApiErrorDetails(details: SanitizedApiErrorDetails | null): "likely-permission-or-auth" | "likely-platform-or-session" | "unclassified" {
  if (!details || typeof details.status !== "number") return "unclassified";
  if (details.isGatewayError || details.isRetryable || details.status >= 500) return "likely-platform-or-session";
  if (details.status === 401 || details.status === 403) return "likely-permission-or-auth";
  return "unclassified";
}

// A real dispatched run (39301756858) found that `getPlatformProxy({
// remoteBindings: true})` can fail its own internal remote-proxy-session
// startup (wrangler's own error: "Failed to start the remote proxy
// session") WITHOUT the process ever exiting -- GitHub Actions had to
// cancel the job after its own 20-minute job-level timeout, ~21 minutes
// after the error was already printed. Confirmed in wrangler 4.92.0's
// own source: this specific error path throws after a local Miniflare
// "proxy server worker" has already been started, without disposing it
// first -- an orphaned local process/handle that keeps Node's event
// loop alive even though the rejected promise itself settled almost
// immediately. There is no handle for OUR code to dispose in this
// failure (the rejection happens before `getPlatformProxy()` ever
// returns a `proxy` object at all), so the only lever available on our
// side is: (a) this bounded timeout, so a FUTURE hang (the promise never
// settling at all, a different failure mode than the one observed)
// fails fast with a clear message instead of waiting for GitHub's own
// blunt job-level timeout, and (b) forcing `process.exit()` once `main()`
// has fully settled (see the apply/recover scripts themselves), which
// terminates the job promptly regardless of what wrangler's internals
// left dangling.
export function withStartupTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// node:sqlite's own row objects have a NULL prototype (confirmed:
// `Object.getPrototypeOf(db.prepare(...).get())` is `null`, not
// `Object.prototype`), while a D1 binding's `.all()` results are
// ordinary plain objects. `assert.deepEqual` under `node:assert/strict`
// (an alias for `deepStrictEqual`) compares prototypes as part of
// equality, so two rows with IDENTICAL column values/types from these
// two different sources never compare equal without this normalization
// -- not a hypothetical: see this module's own test file for a
// reproduction against a real node:sqlite row. A shallow spread is
// sufficient and correct here: every value a SQL row can hold (string,
// number, null, Buffer for BLOB) is already a primitive or an object
// `{...row}` copies by reference unchanged -- there is never a nested
// object to recurse into.
export function normalizeRow(row: Row): Row {
  return { ...row };
}

export function normalizeRows(rows: Row[]): Row[] {
  return rows.map(normalizeRow);
}

// Distinguishes a clean, reported D1/SQLite rejection (a constraint
// violation or SQL error -- the kind of failure D1's own batch atomicity
// guarantees rolls back) from something that does NOT carry that
// guarantee (a network/timeout error, or any OTHER D1 error whose
// specific cause does not itself prove rejection). Deliberately
// conservative and allowlist-based, never a bare `D1_ERROR` substring
// match: D1_ERROR is the generic wrapper prefix on EVERY D1 failure,
// including transient service faults and internal errors that say
// nothing about whether a write actually landed -- matching on that
// alone would misclassify an ambiguous failure as a confirmed-safe one.
// Only a message that also names a SPECIFIC, recognized rejection cause
// counts as "clean."
export function looksLikeCleanRejection(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return /SQLITE_CONSTRAINT|no such table|syntax error|FOREIGN KEY constraint/i.test(message);
}

export type D1LikeDatabase = {
  prepare(sql: string): { all(): Promise<{ results?: unknown[] }> | { results?: unknown[] } };
};

export async function snapshotCalendarTablesViaBinding(db: D1LikeDatabase): Promise<{ links: Row[]; history: Row[] }> {
  const linksResult = await db.prepare("SELECT * FROM calendar_event_links ORDER BY id").all();
  const historyResult = await db.prepare("SELECT * FROM calendar_event_link_history ORDER BY id").all();
  return {
    links: normalizeRows((linksResult?.results ?? []) as Row[]),
    history: normalizeRows((historyResult?.results ?? []) as Row[]),
  };
}

export type SqliteLikeDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
};

export type VerifyBackupResult = {
  matches: boolean;
  restored: { links: Row[]; history: Row[] };
  mismatchReason?: string;
};

// Restores `backupSqlText` into a FRESH, isolated SQLite database
// (supplied via `createSqliteDatabase`, so a test can inject exactly
// the same `node:sqlite` `DatabaseSync` the real script uses -- no
// remote access, no scratch database of any kind) and compares the
// result against `liveRows` (already normalized, e.g. from
// snapshotCalendarTablesViaBinding). Returns a plain result object
// rather than throwing, so the caller -- and tests -- can inspect
// `matches`/`mismatchReason` directly instead of only observing a throw.
export function verifyBackupRestoresAndMatches(
  backupSqlText: string,
  liveRows: { links: Row[]; history: Row[] },
  createSqliteDatabase: () => SqliteLikeDatabase,
): VerifyBackupResult {
  const db = createSqliteDatabase();
  try {
    db.exec(backupSqlText);
    const restoredLinks = normalizeRows(db.prepare("SELECT * FROM calendar_event_links ORDER BY id").all() as Row[]);
    const restoredHistory = normalizeRows(db.prepare("SELECT * FROM calendar_event_link_history ORDER BY id").all() as Row[]);
    const linksMatch = isDeepStrictEqual(restoredLinks, liveRows.links);
    const historyMatch = isDeepStrictEqual(restoredHistory, liveRows.history);
    return {
      matches: linksMatch && historyMatch,
      restored: { links: restoredLinks, history: restoredHistory },
      mismatchReason: !linksMatch ? "calendar_event_links rows do not match" : !historyMatch ? "calendar_event_link_history rows do not match" : undefined,
    };
  } finally {
    db.close();
  }
}

export type RetentionResult = { ok: boolean; reason?: string; remoteKey?: string };

// Every I/O operation retainBackupSecurely needs, as four separate,
// independently-injectable functions -- not one generic "run a shell
// command" escape hatch -- so a test can simulate a failure at EXACTLY
// one stage (compression, encryption, upload, or remote verification)
// and assert the function's behavior at that specific point, per this
// round's own instruction ("Add synthetic tests for encryption/upload
// failures"). Each of compress/encrypt/upload is expected to THROW on
// failure (mirroring what spawnSync-wrapping code naturally does);
// verifyRemoteObject returns `false` for "the object doesn't match",
// which is a normal, non-exceptional outcome, not an error.
export type RetainBackupDeps = {
  compress(sourcePath: string, destPath: string): void;
  encrypt(sourcePath: string, destPath: string): void;
  upload(localPath: string, remoteKey: string): void;
  verifyRemoteObject(remoteKey: string, expectedBytes: number): boolean;
  statSize(path: string): number;
  shred(path: string): void;
};

function describeError(error: unknown): string {
  return (error as { message?: unknown })?.message ? String((error as { message: unknown }).message) : String(error);
}

// Best-effort cleanup only -- a failure to shred an intermediate file
// must never be escalated into a retention failure. What matters for
// retainBackupSecurely's own correctness is its RETURN VALUE (whether
// the backup is safely, verifiably retained), never whether a temp file
// happened to linger.
function safeShred(deps: RetainBackupDeps, path: string): void {
  try {
    deps.shred(path);
  } catch {
    // intentionally ignored -- see comment above.
  }
}

// Encrypts and uploads ONE backup file, verifies the uploaded object
// actually matches before trusting it, and ONLY THEN removes the local
// plaintext/ciphertext copies. This is the fix for a real bug this
// round's review caught: an earlier version of this sequence (written
// as a CI shell step with `set -uo pipefail`, missing `-e`) would let a
// failed compress/encrypt/upload fall through to a "success" message and
// then unconditionally shred every local copy -- silently destroying the
// only recoverable backup on a failure. Every stage here is checked
// explicitly; ANY failure returns `{ok: false, reason}` immediately,
// and `backupPath` (the original, uncompressed, unencrypted export) is
// NEVER removed unless an independent read-back from the remote object
// store confirms the uploaded object's byte size matches what was
// uploaded -- not merely that the upload command exited zero. The
// intermediate `.gz` file is shredded regardless of what happens next
// (it is always reproducible from `backupPath` alone, so losing it is
// harmless), but the ciphertext (`.gz.gpg`) and the original are only
// ever removed together, and only after that verification passes.
export function retainBackupSecurely(backupPath: string, remoteKeyPrefix: string, deps: RetainBackupDeps): RetentionResult {
  const gzPath = `${backupPath}.gz`;
  const gpgPath = `${gzPath}.gpg`;
  const baseName = backupPath.replace(/^.*[\\/]/, "");
  const remoteKey = `${remoteKeyPrefix}/${baseName}.gz.gpg`;

  try {
    deps.compress(backupPath, gzPath);
  } catch (error) {
    return { ok: false, reason: `Compression failed: ${describeError(error)}` };
  }

  try {
    deps.encrypt(gzPath, gpgPath);
  } catch (error) {
    return { ok: false, reason: `Encryption failed: ${describeError(error)}` };
  } finally {
    safeShred(deps, gzPath);
  }

  let expectedBytes: number;
  try {
    expectedBytes = deps.statSize(gpgPath);
  } catch (error) {
    return { ok: false, reason: `Could not determine the encrypted file's size: ${describeError(error)}` };
  }

  try {
    deps.upload(gpgPath, remoteKey);
  } catch (error) {
    return { ok: false, reason: `Upload failed: ${describeError(error)}` };
  }

  let verified: boolean;
  try {
    verified = deps.verifyRemoteObject(remoteKey, expectedBytes);
  } catch (error) {
    return { ok: false, reason: `Remote verification failed: ${describeError(error)}` };
  }
  if (!verified) {
    return { ok: false, reason: `Remote object "${remoteKey}" does not match the uploaded content (size mismatch or not found) -- refusing to treat this backup as retained.` };
  }

  // Reached only once compression, encryption, upload, AND an
  // independent remote read-back have all explicitly succeeded.
  safeShred(deps, gpgPath);
  safeShred(deps, backupPath);
  return { ok: true, remoteKey };
}

// The narrow checkpoint this round's review asked for: the repair batch
// is structurally UNREACHABLE unless `retainPreRepairBackup()` first
// reports success. This is not "the script is supposed to check first
// and then proceed" (a convention that a future edit could accidentally
// break) -- `db.batch` is never referenced in this function at all
// unless control has already passed the `if (!retention.ok) throw`
// above it, so the one test that matters
// ("the repair is never invoked when pre-repair retention fails") can
// assert it directly: inject a `db` whose `batch` records whether it
// was ever called, and a failing `retainPreRepairBackup`.
export async function applyRepairBatchGuardedByRetention(
  db: { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> },
  statements: string[],
  retainPreRepairBackup: () => RetentionResult | Promise<RetentionResult>,
): Promise<RetentionResult> {
  const retention = await retainPreRepairBackup();
  if (!retention.ok) {
    throw new PhaseError("pre-repair-retention", `The pre-repair backup could not be retained securely -- refusing to apply the repair: ${retention.reason}`);
  }
  await db.batch(statements.map((statement) => db.prepare(statement)));
  return retention;
}

const READ_ONLY_INSPECTION_GUIDANCE =
  "Run these read-only queries against Staging first (via `npx wrangler@4.92.0 d1 execute fundraising-os-staging-db --remote --config wrangler.staging-repair.jsonc --command \"...\"`) and compare the result to the 'before' snapshot printed earlier in this run's own log:\n" +
  "  SELECT COUNT(*) FROM calendar_event_links;\n" +
  "  SELECT COUNT(*) FROM calendar_event_link_history;\n" +
  "  SELECT sql FROM sqlite_schema WHERE type='table' AND name IN ('calendar_event_links','calendar_event_link_history');\n" +
  "Only after that read-only inspection shows a genuinely ambiguous state (neither clearly the original schema nor clearly the correct repaired result) should scripts/recover-0049-calendar-schema-repair-staging.mjs be considered, against the pre-repair backup printed earlier in this run.";

// Nothing on Staging was touched yet at any of these phases.
// "pre-repair-retention" means retainBackupSecurely() itself reported
// failure -- by construction (applyRepairBatchGuardedByRetention), that
// means db.batch() was never even called, so this belongs here too.
const PRE_REPAIR_PHASES = new Set(["preflight", "target-validation", "pre-repair-backup", "pre-repair-restore-check", "before-snapshot", "pre-repair-retention"]);

// The repair batch already committed successfully, AND the very next
// check (post-batch-row-check) already confirmed every row survived --
// a failure at one of THESE phases is a separate, later verification
// problem, never a reason to revert an already-verified repair.
// "post-repair-retention" means the repair itself (already independently
// verified via row/FK/schema checks) succeeded, but the POST-repair
// backup could not be retained securely -- the job must still fail
// loudly (never a silent success) so a human notices and can re-attempt
// retention, but that is a backup-retention problem, not a reason to
// doubt or revert the already-verified repair.
const POST_SUCCESS_VERIFICATION_PHASES = new Set(["fk-integrity-check", "schema-health-check", "post-repair-restore-check", "post-repair-retention"]);

// Builds the exact, phase-specific guidance text for a failure --
// deliberately allowlist-based (PRE_REPAIR_PHASES /
// POST_SUCCESS_VERIFICATION_PHASES), not "whatever didn't match an
// earlier branch falls through to the generic message": an
// unrecognized phase (a future bug, a typo'd phase name) must default
// to UNCERTAIN, never to the dangerous "already succeeded, no action
// needed" message a bare fallthrough would have produced.
export function describeFailure(error: unknown): string {
  const phase = error instanceof PhaseError ? error.phase : "unknown";
  const lines: string[] = [`ABORTED during phase "${phase}": ${(error as Error)?.message ?? error}`];
  const cause = (error as { cause?: unknown })?.cause;
  if (cause) lines.push(`Cause: ${(cause as Error)?.message ?? cause}`);

  if (PRE_REPAIR_PHASES.has(phase)) {
    lines.push("Nothing on Staging was touched -- this failed before the repair batch was ever attempted. Fix the cause above and re-run; no recovery action of any kind is needed.");
    return lines.join("\n");
  }

  if (phase === "repair-batch") {
    if (looksLikeCleanRejection(cause ?? error)) {
      lines.push("The repair batch itself was rejected by D1 with a recognizable, specific error (not a network failure, and not just a generic D1_ERROR wrapper). D1's own batch atomicity guarantees this means Staging was NEVER partially modified -- no recovery action is needed. Investigate the error above and re-run once fixed.");
    } else {
      lines.push(
        `The repair batch call failed with something that does NOT look like a clean, specific rejection (possibly a network/timeout error, or an unrecognized D1 error whose cause does not itself prove rejection) -- whether it actually committed before failing is genuinely UNKNOWN. Do not guess, and do not re-run blindly.\n${READ_ONLY_INSPECTION_GUIDANCE}`,
      );
    }
    return lines.join("\n");
  }

  if (phase === "post-batch-row-check") {
    lines.push(
      `The repair batch itself returned successfully, but the row-preservation check that was supposed to CONFIRM every row survived unchanged did NOT pass (or could not complete) -- data preservation is UNVERIFIED or MISMATCHED, not confirmed either way. Do not assume the repair is safe, and do not assume it corrupted anything either.\n${READ_ONLY_INSPECTION_GUIDANCE}`,
    );
    return lines.join("\n");
  }

  if (POST_SUCCESS_VERIFICATION_PHASES.has(phase)) {
    lines.push(
      "The repair batch itself already committed successfully, and the very next step already confirmed every row in both tables survived unchanged -- this failure is in a LATER, SEPARATE verification step. Do NOT restore the pre-repair backup on this basis alone; that would UNDO an already-successful, already-verified repair over an unrelated later check. Investigate the specific failed check above with read-only queries before taking any action.",
    );
    return lines.join("\n");
  }

  lines.push(`Unrecognized failure phase "${phase}" -- treat this as UNCERTAIN, the same as an ambiguous repair-batch failure. Do not assume Staging's state either way.\n${READ_ONLY_INSPECTION_GUIDANCE}`);
  return lines.join("\n");
}
