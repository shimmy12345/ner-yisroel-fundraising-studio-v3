// ============================================================================
// DRAFT -- PREPARED, NOT RUN. PENDING SEPARATE, EXPLICIT OWNER AUTHORIZATION.
// ============================================================================
// Bounded, diagnostic-only: attempts the SAME target-validation
// connection scripts/apply-0049-calendar-schema-repair-staging.mjs
// performs as its own first step
// (connectAndValidateStagingTarget() -- the SAME two independent paths
// (the D1 binding and the wrangler CLI), the SAME existing
// CLOUDFLARE_D1_API_TOKEN/CLOUDFLARE_ACCOUNT_ID secrets, the SAME
// dedicated wrangler.staging-repair.jsonc config), and STOPS
// IMMEDIATELY after -- success or failure. This script NEVER calls
// `wrangler d1 export`, never applies the repair batch, never runs
// scripts/recover-0049-calendar-schema-repair-staging.mjs, and never
// creates a scratch D1 database. It exists purely to capture and print
// the ACTUAL Cloudflare HTTP status code, API error code, and a
// sanitized error message from a real connection attempt, so a
// permission/auth rejection can be told apart from a platform/session
// failure BEFORE deciding what (if anything) to change.
//
// Uses wrangler's own ALREADY-EXISTING diagnostic fields -- confirmed
// directly in its bundled source (`src/parse.ts`'s `APIError` class):
// a failed Cloudflare API call's error object already carries
// `.status` (the real HTTP status) and `.code` (Cloudflare's own
// numeric API error code, when the response included one), plus
// `isGatewayError()`/`isRetryable()` helpers wrangler itself uses to
// recognize a platform/gateway problem. NO new instrumentation was
// added to wrangler -- see
// lib/operations/calendar-schema-repair-apply.ts's own
// extractApiErrorDetails()/classifyApiErrorDetails() for the exact
// fields this script surfaces and why each one is already safe to
// print.
//
// NEVER prints: the API token, any Authorization header, a full
// environment dump, or any donor/business data -- this script never
// reads a single row of real data at all (connectAndValidateStagingTarget()
// itself only ever queries `sqlite_schema`, never an application
// table). The one field wrangler's own error object carries that this
// script deliberately never prints is `.accountTag` (an account
// identifier, not a secret, but consistent with wrangler's own practice
// of redacting it as `***` in its console output).
//
// Uses ONLY the existing CLOUDFLARE_D1_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
// secrets already wired into this repo's CI -- no new credential, no
// change to any token's permissions, no different execution mechanism
// than what the real repair already uses for this exact step.
//
// Usage (after separate authorization):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/diagnose-staging-connection.mjs
// ============================================================================

import { connectAndValidateStagingTarget } from "./lib/staging-repair-connect.mjs";
import { extractApiErrorDetails, classifyApiErrorDetails } from "../lib/operations/calendar-schema-repair-apply.ts";

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set.");
  }

  console.log("Diagnostic-only mode: attempting target validation (the SAME connection the real repair performs as its own first step), then stopping. No backup export, repair, recovery, or scratch database will be attempted, regardless of outcome.");

  const { dispose } = await connectAndValidateStagingTarget();
  console.log("\nConnection and target validation SUCCEEDED. Stopping here -- this mode never proceeds past this point, by design.");
  await dispose();
}

function describeClassification(classification) {
  if (classification === "likely-permission-or-auth") {
    return "a 401/403 means the token authenticated but was not allowed to do this specific thing -- consistent with the Workers Scripts permission gap reported in docs/AI-HANDOFF.md's prior round.";
  }
  if (classification === "likely-platform-or-session") {
    return "a 5xx / gateway / retryable status means Cloudflare's own platform or session machinery had a problem independent of token permissions -- retrying later may simply work, and broadening any permission would not help.";
  }
  return "the status code alone does not clearly indicate either cause -- further investigation (e.g. the Cloudflare dashboard's own API Tokens page, or Cloudflare's own status page) is needed before deciding a remedy.";
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nConnection and/or target validation FAILED.");
    const details = extractApiErrorDetails(error);
    if (details) {
      const classification = classifyApiErrorDetails(details);
      console.error(`HTTP status: ${details.status}`);
      if (details.code !== undefined) console.error(`Cloudflare API error code: ${details.code}`);
      if (details.isGatewayError !== undefined) console.error(`isGatewayError(): ${details.isGatewayError}`);
      if (details.isRetryable !== undefined) console.error(`isRetryable(): ${details.isRetryable}`);
      console.error(`Sanitized error message: ${details.message}`);
      console.error(`Classification: ${classification} -- ${describeClassification(classification)}`);
    } else {
      console.error("No structured Cloudflare API error (HTTP status/error code) was found anywhere in this error's own cause chain. Whatever detail IS available:");
      console.error(`Error: ${error.message}`);
      if (error.cause) console.error(`Cause: ${error.cause.message ?? error.cause}`);
    }
    console.error("\nNothing beyond this read-only connection attempt was performed. Staging is unchanged.");
    process.exit(1);
  });
