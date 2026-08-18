import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression coverage for Design C, ported narrowly from
// feature/independent-cloudflare-sandbox: latest/'s own R2 object metadata
// (dated-backup-key, attached in the SAME PutObject call that writes its
// content -- see d1-backup-nightly.yml's "Update the 'latest' pointer"
// step) is the single source of truth d1-restore-verify-monthly.yml uses
// to restore and verify a specific, provable, immutable dated backup
// instead of guessing from upload timestamps or trusting a separate,
// racy artifact.
//
// The security-critical piece -- strict allowlist validation of untrusted
// R2 metadata before it is ever used as an object key -- is tested here by
// extracting the EXACT bash logic from the real workflow file (never a
// hand-copied reimplementation that could silently drift from what's
// actually committed) and executing it for real via bash, against both a
// valid input and a battery of adversarial ones. The date-canonicalization
// logic is tested the same way. This is stronger than source-text
// pattern-matching alone (see test/d1-backup-status-publish.test.mjs for
// that style, used here only for the mechanical, low-risk parts).

const nightly = await readFile(new URL("../.github/workflows/d1-backup-nightly.yml", import.meta.url), "utf8");
const monthly = await readFile(new URL("../.github/workflows/d1-restore-verify-monthly.yml", import.meta.url), "utf8");

function extractSpan(text, startMarker, endMarker, label) {
  const startIdx = text.indexOf(startMarker);
  assert.ok(startIdx >= 0, `${label}: start marker not found -- "${startMarker}"`);
  const endIdx = text.indexOf(endMarker, startIdx);
  assert.ok(endIdx >= 0, `${label}: end marker not found -- "${endMarker}"`);
  return text.slice(startIdx, endIdx);
}

// Runs a bash snippet with the given environment additions, providing a
// real GITHUB_OUTPUT file (matching the real runner's own contract --
// >> "$GITHUB_OUTPUT" is a real append-to-file operation in production;
// leaving it unset here would make that redirect fail against an empty
// filename, an artifact of the test harness having nothing to do with the
// logic under test). Returns {stdout, code, outputs} where outputs is the
// parsed key=value contents of that file. Never throws on a non-zero
// exit -- callers assert on it explicitly.
function runBash(script, env) {
  const dir = mkdtempSync(join(tmpdir(), "gh-output-"));
  const outputFile = join(dir, "output");
  try {
    const stdout = execFileSync("bash", ["-c", script], { env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile }, encoding: "utf8" });
    const outputs = existsSync(outputFile) ? Object.fromEntries(readFileSync(outputFile, "utf8").split("\n").filter(Boolean).map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; })) : {};
    return { stdout, code: 0, outputs };
  } catch (error) {
    return { stdout: error.stdout ?? "", code: error.status ?? 1, outputs: {} };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  // ==========================================================================
  // Category: valid metadata, missing metadata, malformed metadata, wrong
  // database/prefix, malicious/unexpected metadata -- all against the REAL,
  // extracted validation logic.
  // ==========================================================================
  // Ends right after the closing `fi` of the "if [ \"${VALID}\" = \"true\" ]"
  // block -- deliberately excludes the OUTER wrapper's own else/fi (which
  // belongs to "if aws s3api head-object...; then" and isn't part of the
  // validation logic itself), so the extracted fragment is self-contained
  // and syntactically balanced on its own.
  const validationScript = extractSpan(monthly, "VALID=false", 'else\r\n            echo "::warning::Could not HEAD', "identity-validation");
  // Sanity: the extraction actually captured the real regex, not an empty
  // or unrelated span -- guards against the anchors silently matching the
  // wrong location after a future edit.
  assert.match(validationScript, /EXPECTED_PATTERN="\^daily\/\$\{DATABASE_NAME\}-\[0-9\]\{8\}T\[0-9\]\{6\}Z\\\.sql\\\.gz\\\.gpg\\\$"/, "extraction sanity: must contain the real allowlist pattern");

  function validate(datedKey) {
    // DATED_KEY is provided directly (standing in for what the real script
    // would have parsed out of latest-head.json via jq) -- this isolates
    // the validation logic itself from the jq/aws plumbing around it,
    // which is covered separately below and by static checks. Reads the
    // real GITHUB_OUTPUT contract (known=/key=), not a bolted-on echo, so
    // this proves the actual "$GITHUB_OUTPUT" lines the real job would
    // produce for the download step to consume.
    // Mirrors the real step's own unconditional default (the real file's
    // very first line, written before the "if aws s3api head-object..."
    // wrapper this extraction starts inside of) -- known=false unless the
    // validation below explicitly overrides it.
    const wrapped = `echo "known=false" >> "$GITHUB_OUTPUT"\nDATED_KEY="\${DATED_KEY_INPUT}"\n${validationScript}\n`;
    assert.match(monthly, /echo "known=false" >> "\$GITHUB_OUTPUT"/, "extraction sanity: the real step must have this same unconditional default");
    const result = runBash(wrapped, { DATABASE_NAME: "fundraising-os-staging-db", DATED_KEY_INPUT: datedKey });
    assert.ok(result.outputs.known === "true" || result.outputs.known === "false", `validation script did not produce a known= output for input ${JSON.stringify(datedKey)}; stdout: ${result.stdout}`);
    return { known: result.outputs.known === "true", key: result.outputs.key };
  }

  // Valid metadata -- and the exact validated key is what gets published,
  // never a re-derived or normalized copy.
  assert.deepEqual(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg"), { known: true, key: "daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg" }, "the exact expected form must validate, publishing the identical key");
  assert.equal(validate("daily/fundraising-os-staging-db-20260101T000000Z.sql.gz.gpg").known, true, "a different but well-formed timestamp must also validate");

  // Missing metadata.
  assert.equal(validate("").known, false, "empty/missing metadata must not validate");

  // Malformed metadata (timestamp shape).
  assert.equal(validate("daily/fundraising-os-staging-db-2026081T082441Z.sql.gz.gpg").known, false, "a too-short date segment must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441.sql.gz.gpg").known, false, "a missing trailing Z must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-2026081XT082441Z.sql.gz.gpg").known, false, "non-digit characters in the timestamp must be rejected");

  // Wrong database/prefix.
  assert.equal(validate("latest/fundraising-os-staging-db.sql.gz.gpg").known, false, "the mutable latest/ key itself must never validate as a dated identity");
  assert.equal(validate("daily/some-other-database-20260818T082441Z.sql.gz.gpg").known, false, "a different database name must be rejected");
  assert.equal(validate("DAILY/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg").known, false, "a wrong-case prefix must be rejected -- matching is case-sensitive");
  assert.equal(validate("daily/subdir/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg").known, false, "an extra path segment must be rejected");
  assert.equal(validate("some/totally/unrelated/object.txt").known, false, "an arbitrary, unrelated object key must be rejected");

  // Malicious/unexpected metadata.
  assert.equal(validate("daily/../../etc/passwd").known, false, "path traversal must be rejected");
  assert.equal(validate("../daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg").known, false, "leading path traversal must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg\nrm -rf /").known, false, "an embedded newline (attempted command injection via a second line) must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg; rm -rf /").known, false, "a shell metacharacter (semicolon) must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg$(whoami)").known, false, "a shell command-substitution metacharacter must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg`id`").known, false, "a shell backtick metacharacter must be rejected");
  assert.equal(validate(" daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg").known, false, "leading whitespace must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg ").known, false, "trailing whitespace must be rejected");
  assert.equal(validate("daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpgEXTRA").known, false, "a valid-prefix key with an unexpected suffix must be rejected");

  // ==========================================================================
  // Category: verifiedBackupCompletedAt derivation -- the real date-
  // canonicalization logic, executed against a realistic AWS/R2
  // LastModified value, an empty value, and a malformed value.
  // ==========================================================================
  // Starts AFTER the jq extraction line (jq isn't installed in this local
  // test environment; RAW_LAST_MODIFIED is supplied directly instead,
  // standing in for what jq would have parsed out of the real GetObject
  // response -- the jq expression itself is covered by the static check
  // below) and captures exactly the canonicalization logic.
  const dateScript = extractSpan(monthly, 'if [ -n "${RAW_LAST_MODIFIED}" ]; then', 'if [ -z "${TESTED_AT}" ]; then', "date-canonicalization");
  assert.match(dateScript, /date -u -d "\$\{RAW_LAST_MODIFIED\}" \+%Y-%m-%dT%H:%M:%SZ/, "extraction sanity: must contain the real date-canonicalization call");
  assert.match(monthly, /jq -r '\.LastModified \/\/ empty' download-response\.json/, "static check: the real script must extract LastModified via this exact jq filter");

  function canonicalize(rawLastModified) {
    const wrapped = `RAW_LAST_MODIFIED="\${RAW_INPUT}"\nTESTED_AT=""\n${dateScript}\necho "RESULT_AT=\${TESTED_AT}"\n`;
    const result = runBash(wrapped, { RAW_INPUT: rawLastModified });
    const match = result.stdout.match(/RESULT_AT=(.*)/);
    assert.ok(match, `date script did not produce a RESULT_AT line; stdout: ${result.stdout}`);
    return match[1].trim();
  }

  assert.equal(canonicalize("2026-08-17T08:32:36+00:00"), "2026-08-17T08:32:36Z", "a realistic AWS-CLI-style LastModified must canonicalize to this system's Z-suffixed convention");
  assert.equal(canonicalize(""), "", "an empty LastModified must never fall through to date's own 'empty string means now' default -- must stay empty, not silently become today's date");
  assert.equal(canonicalize("not-a-real-date"), "", "an unparseable LastModified must produce an empty result, never a guessed date");

  // ==========================================================================
  // Category: legacy latest/ fallback, immutable-key restoration, published
  // fields, credential timing/boundary -- static structural checks (the
  // control-flow shape and credential scoping, not adversarial-input logic).
  // ==========================================================================
  assert.match(monthly, /aws s3api head-object --endpoint-url "\$\{ENDPOINT_URL\}" --bucket "\$\{BUCKET\}" --key "latest\/\$\{DATABASE_NAME\}\.sql\.gz\.gpg" > latest-head\.json/, "must HEAD latest/ exactly once to determine identity");
  assert.equal((monthly.match(/aws s3api head-object/g) ?? []).length, 1, "must never HEAD latest/ a second time to double-check identity");
  assert.match(monthly, /aws s3api get-object --endpoint-url "\$\{ENDPOINT_URL\}" --bucket "\$\{BUCKET\}" --key "\$\{IDENTITY_KEY\}" latest\.sql\.gz\.gpg/, "must restore the SAME validated immutable key captured by the identity step");
  assert.match(monthly, /aws s3api get-object --endpoint-url "\$\{ENDPOINT_URL\}" --bucket "\$\{BUCKET\}" --key "latest\/\$\{DATABASE_NAME\}\.sql\.gz\.gpg" latest\.sql\.gz\.gpg/, "the legacy/unknown-identity fallback must still restore latest/ directly");
  // Main's publish step uses one jq call with jq's own if/then/else/end
  // (not a bash-level if/else) to choose between a real identity and
  // explicit nulls -- see the credential-timing/nested-if note below for
  // why: a second bash-level if/fi inside "if JOB_STATUS = success" would
  // break this file's own d1-backup-status-publish.test.mjs regex, which
  // expects exactly one such block.
  assert.match(monthly, /verifiedBackupObjectKey: \(if \$known == "true" then \$backupKey else null end\)/, "the published record must derive verifiedBackupObjectKey from jq's own conditional, defaulting to explicit null -- never a guessed identity");
  assert.match(monthly, /verifiedBackupCompletedAt: \(if \$known == "true" then \$backupAt else null end\)/, "verifiedBackupCompletedAt must be gated on the SAME $known flag as verifiedBackupObjectKey -- both known or both null together");

  // Credential timing/boundary: the identity step must use only the
  // read-only backup-bucket credential (same as the download step just
  // after it), and R2_STATUS_WRITE_* must appear nowhere before the
  // publish step -- also directly proven, unmodified, by this repo's own
  // test/d1-backup-status-publish.test.mjs, which needed zero changes for
  // this port (Design C never needs the status-bucket credential to
  // determine identity at all).
  const identityStepIndex = monthly.indexOf("Determine and validate the immutable backup identity from latest/'s metadata");
  assert.ok(identityStepIndex > 0, "the identity step must exist under its expected name");
  const publishStepIndex = monthly.indexOf("Publish restore-verification status");
  assert.ok(publishStepIndex > identityStepIndex, "the publish step must come after the identity step");
  const beforePublish = monthly.slice(0, publishStepIndex);
  assert.doesNotMatch(beforePublish, /R2_STATUS_WRITE_ACCESS_KEY_ID/, "R2_STATUS_WRITE_ACCESS_KEY_ID must never appear before the publish step -- Design C's identity step uses only R2_BACKUP_READ_*");
  const identityAndDownloadText = monthly.slice(identityStepIndex, publishStepIndex);
  assert.match(identityAndDownloadText, /R2_BACKUP_READ_ACCESS_KEY_ID/, "the identity/download steps must use the existing read-only backup-bucket credential");
  assert.doesNotMatch(identityAndDownloadText, /R2_BACKUP_WRITE_ACCESS_KEY_ID/, "the identity/download steps must never hold write access to the backup bucket");

  // The nightly workflow's metadata write happens in the SAME PutObject
  // call that writes latest/'s content -- one statement, not two separate
  // API calls that could race or partially fail against each other.
  const latestPointerStepIndex = nightly.indexOf("Update the 'latest' pointer");
  const cleanupStepIndex = nightly.indexOf("Clean up local plaintext/ciphertext");
  assert.ok(latestPointerStepIndex > 0 && cleanupStepIndex > latestPointerStepIndex);
  const latestPointerStepText = nightly.slice(latestPointerStepIndex, cleanupStepIndex);
  assert.equal((latestPointerStepText.match(/aws s3api put-object/g) ?? []).length, 1, "latest/'s content and its dated-backup-key metadata must be written by exactly one PutObject call, not two");
  assert.match(latestPointerStepText, /--metadata "dated-backup-key=\$\{DATED_KEY\}"/, "the metadata flag must be part of that same put-object invocation");
  assert.match(latestPointerStepText, /DATED_KEY="daily\/\$\{DATABASE_NAME\}-\$\{\{ steps\.stamp\.outputs\.value \}\}\.sql\.gz\.gpg"/, "the attached dated-backup-key must be computed identically to the real dated upload's own key");

  console.log("Backup identity metadata (Design C) checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
