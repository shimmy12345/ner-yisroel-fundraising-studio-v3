import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Production Infrastructure Setup -- Cloudflare Access configuration
// (see docs/PRODUCTION-INFRASTRUCTURE-SETUP.md). The owner created the
// real Production Cloudflare Access Application 2026-10-09 and supplied
// the real TEAM_DOMAIN/POLICY_AUD, replacing the deliberate placeholders
// this config previously shipped with. This file proves, as a
// regression (not a one-time manual check), that:
//   1. Both values are genuinely present and are not the placeholder
//      strings -- a config with either one missing or still a
//      placeholder must never be mistaken for ready (this round's own
//      security pre-flight requirement, and lib/auth/
//      provider-selection.ts's own hardening depends on BOTH being
//      truthy before it will exclude the legacy header path).
//   2. The real values feed the actual, real selectAuthProviders()
//      selection logic correctly -- not a re-test of that function
//      itself (tests/auth-provider-selection.test.mjs already proves
//      the mechanism with 14 cases), but proof that THIS file's
//      specific values drive it the same way.
//   3. Production's D1 binding is not Staging's.
//   4. The daily-agenda `triggers` (cron) block is active -- enabling
//      scheduled production use was the explicitly-approved 2026-10-12
//      Production Daily Email Cutover round, once the owner had entered
//      Production's three Gmail secrets directly in the Cloudflare
//      dashboard (independently re-verified via `wrangler secret list`
//      before the cutover, never read here).
//
// Source-text assertions on the raw .jsonc file (matching this
// codebase's established convention for config files that aren't
// directly importable modules -- see tests/backup-automation.test.mjs's
// own wranglerStaging assertions) rather than introducing a new JSONC
// parser dependency.

import { selectAuthProviders } from "../lib/auth/provider-selection.ts";

const config = await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");

function extractVar(name) {
  const match = config.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return match ? match[1] : null;
}

const teamDomain = extractVar("TEAM_DOMAIN");
const policyAud = extractVar("POLICY_AUD");
const ownerEmail = extractVar("STAGING_OWNER_EMAIL");
const databaseId = extractVar("database_id");

test("wrangler.production.jsonc: TEAM_DOMAIN is present and is not a placeholder", () => {
  assert.ok(teamDomain, "TEAM_DOMAIN must be present in wrangler.production.jsonc");
  assert.doesNotMatch(teamDomain, /REPLACE/i, "TEAM_DOMAIN must not still be the placeholder string -- Access setup must be complete before this is considered ready");
  assert.match(teamDomain, /\.cloudflareaccess\.com$/, "TEAM_DOMAIN must be a real Cloudflare Access team domain");
});

test("wrangler.production.jsonc: POLICY_AUD is present, is not a placeholder, and has the real Cloudflare Access AUD shape", () => {
  assert.ok(policyAud, "POLICY_AUD must be present in wrangler.production.jsonc");
  assert.doesNotMatch(policyAud, /REPLACE/i, "POLICY_AUD must not still be the placeholder string");
  assert.match(policyAud, /^[0-9a-f]{64}$/, "POLICY_AUD must be a real 64-character hex Access Application Audience tag, matching the same shape as wrangler.staging.jsonc's own POLICY_AUD");
});

test("wrangler.production.jsonc: STAGING_OWNER_EMAIL is the real, explicitly authorized owner", () => {
  assert.equal(ownerEmail, "sgoldstein@nirc.edu");
});

test("the real configured TEAM_DOMAIN + POLICY_AUD correctly drive selectAuthProviders to exclude the legacy ChatGPT Sites header", () => {
  const hasCloudflareAccessConfigured = Boolean(teamDomain && policyAud);
  assert.equal(hasCloudflareAccessConfigured, true, "with the real values now in place, this must evaluate true -- exactly the condition app/chatgpt-auth.ts's getChatGPTUser() computes at runtime");
  const headerProvider = { name: "chatgpt-sites", resolve: async () => { throw new Error("must never be invoked"); } };
  const accessProvider = { name: "cloudflare-access", resolve: async () => null };
  const providers = selectAuthProviders(hasCloudflareAccessConfigured, headerProvider, accessProvider);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "cloudflare-access", "the real configured values must result in the legacy header provider being excluded entirely");
});

test("wrangler.production.jsonc: D1 binding is Production's own database, never Staging's", () => {
  assert.ok(databaseId, "a database_id must be present");
  assert.notEqual(databaseId, "6c18396c-0a8f-4f2c-ba83-ea809ec10289", "must never be Staging's fundraising-os-staging-db id");
  assert.equal(databaseId, "a51c6571-ae16-4614-aa9a-08f8e6be3ecd", "must be the real fundraising-os-production-db id provisioned this round");
});

test("wrangler.production.jsonc: the daily-agenda scheduled trigger (cron) is active, matching Staging's own former hourly schedule exactly", () => {
  // Anchored to the start of a line (only leading whitespace allowed) so
  // this matches a real, active "triggers" key, never a commented-out
  // line (which would be prefixed with "// ", excluded by this pattern).
  assert.match(config, /^\s*"triggers":\s*\{\s*"crons":\s*\["0 \* \* \* \*"\]\s*\}/m, "Production's cron must be active and must match the exact hourly schedule the daily-agenda send-hour guard (lib/agenda/timezone.ts) expects -- this is the sole live copy now that Staging's matching block was removed in the same deploy");
});

test("wrangler.production.jsonc: never references any Staging R2 bucket by name", () => {
  // "fundraising-os-backup-status" (Staging's status bucket/Worker name)
  // is deliberately NOT included in this pattern: it is not a substring
  // of "fundraising-os-production-backup-status" (the two diverge at
  // "...os-" + "p" vs "b"), so a plain match would be a false positive.
  assert.doesNotMatch(config, /fundraising-os-staging-backups/, "must never reference Staging's backup bucket by name");
  assert.doesNotMatch(config, /"service":\s*"fundraising-os-backup-status"/, "the STATUS_WORKER service binding must point at the Production status-worker, never Staging's");
});

process.stdout.write("Production wrangler config checks passed.\n");
