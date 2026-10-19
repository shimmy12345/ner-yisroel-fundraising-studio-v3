// Pure, offline-testable target-identity validation for
// scripts/apply-0049-calendar-schema-repair-staging.mjs. Deliberately
// separate from any wrangler/network call: every function here takes
// plain data the caller already fetched, so the validation LOGIC itself
// (what counts as a mismatch, what counts as "missing results") can be
// unit tested without real credentials or a real D1 database at all --
// see tests/staging-repair-target-validation.test.mjs.
//
// Why this exists: `getPlatformProxy({remoteBindings: true})` connects a
// D1 binding to the REAL remote database only when that binding's own
// wrangler config entry also carries `"remote": true` (confirmed in
// wrangler's own source -- see wrangler.staging-repair.jsonc's header).
// Get that wrong -- wrong config file, wrong database_id, a future
// wrangler/Miniflare change, an expired/misscoped token that silently
// degrades to some other resolution path -- and the binding can end up
// talking to an EMPTY LOCAL SIMULATED database while every call still
// appears to succeed. The only way to catch that before it matters is to
// independently read the SAME live state through a second, different
// path (the wrangler CLI's own `d1 execute --remote`) and refuse to
// proceed unless the two agree.
import { createHash } from "node:crypto";
import { stagingSchemaObjects } from "../data-health/production-baseline.ts";

// The real Staging D1 database's own identity, as declared in both
// wrangler.staging.jsonc and wrangler.staging-repair.jsonc. A UUID, not a
// name -- names can collide or be typo'd into looking right; this cannot.
export const STAGING_REPAIR_EXPECTED_DATABASE_ID = "6c18396c-0a8f-4f2c-ba83-ea809ec10289";

export type SchemaRow = { name: unknown; type: unknown; sql: unknown };

// A stable fingerprint of a database's live schema (every table and
// index, normalized the same way lib/data-health/production-baseline.ts's
// own compareSchemaObjects() does) -- used to prove two different access
// paths (the D1 binding and the wrangler CLI) are actually looking at the
// SAME database, not merely a database with the same name.
export function computeSchemaFingerprint(rows: SchemaRow[]): string {
  const objects = stagingSchemaObjects(rows as Array<Record<string, unknown>>);
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

export type RepairTargetValidationInput = {
  // The database_id the CLI (wrangler d1 info / d1 list) reports for the
  // target database, independent of whatever the binding resolved.
  cliDatabaseId: string | null | undefined;
  // How many schema rows (tables+indexes) each path actually returned.
  // A real Staging database has dozens; an empty/fresh local simulated
  // database has none at all for a never-migrated binding, or a
  // different full set from a DIFFERENT real database.
  bindingRowCount: number;
  cliRowCount: number;
  bindingFingerprint: string;
  cliFingerprint: string;
  // Optional: if the operator supplied an expected account id (there is
  // no committed "known" account id in this repo -- see
  // scripts/apply-0049-calendar-schema-repair-staging.mjs's own header
  // for why), cross-check it against what the CLI's own auth context
  // reports. Omit either side to skip this specific check.
  expectedAccountId?: string | null;
  cliAccountId?: string | null;
};

export type RepairTargetValidationResult = { ok: boolean; errors: string[] };

// Fails closed: ANY of these conditions not being satisfiable from the
// given input is a hard stop, never a warning. Every branch below
// corresponds to one concrete way the binding could silently be looking
// at the wrong database (or no database at all) while still appearing to
// return successfully.
export function validateRepairTarget(input: RepairTargetValidationInput): RepairTargetValidationResult {
  const errors: string[] = [];

  if (!input.cliDatabaseId) {
    errors.push("Could not determine the target database's id via the wrangler CLI (missing result) -- refusing to proceed.");
  } else if (input.cliDatabaseId !== STAGING_REPAIR_EXPECTED_DATABASE_ID) {
    errors.push(`The wrangler CLI resolved a database id of "${input.cliDatabaseId}", which does not match Staging's known database id "${STAGING_REPAIR_EXPECTED_DATABASE_ID}".`);
  }

  if (!Number.isInteger(input.bindingRowCount) || input.bindingRowCount <= 0) {
    errors.push(`The D1 binding returned ${input.bindingRowCount} schema row(s) -- a real Staging database must have dozens of tables/indexes; an empty result is the signature of a local-simulated fallback, not a connection to real Staging.`);
  }
  if (!Number.isInteger(input.cliRowCount) || input.cliRowCount <= 0) {
    errors.push(`The wrangler CLI returned ${input.cliRowCount} schema row(s) -- missing results, refusing to proceed.`);
  }

  if (input.bindingFingerprint && input.cliFingerprint && input.bindingFingerprint !== input.cliFingerprint) {
    errors.push("The D1 binding's own schema fingerprint does not match the wrangler CLI's schema fingerprint for the same database -- they are not looking at the same data. This is exactly the signature of the binding silently falling back to a local simulated database. Refusing to proceed.");
  } else if (!input.bindingFingerprint || !input.cliFingerprint) {
    errors.push("Could not compute a schema fingerprint from one of the two paths (missing data) -- refusing to proceed.");
  }

  if (input.expectedAccountId && input.cliAccountId && input.expectedAccountId !== input.cliAccountId) {
    errors.push(`The wrangler CLI's authenticated account id "${input.cliAccountId}" does not match the operator-supplied expected account id "${input.expectedAccountId}".`);
  }

  return { ok: errors.length === 0, errors };
}
