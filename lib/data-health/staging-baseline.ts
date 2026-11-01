import manifest from "../../production-baseline/staging-schema-manifest.json" with { type: "json" };
import type { SchemaObject } from "./production-baseline.ts";

// Staging's OWN schema baseline -- separate from production-baseline.ts
// on purpose (2026-11-01, "D1 monthly restore verification both failing
// for real reasons" investigation, see docs/AI-HANDOFF.md). Before this
// file existed, scripts/verify-remote-restore.mjs compared BOTH the
// Staging and Production monthly restore-verify runs against the one
// Production-scoped manifest (production-baseline/schema-manifest.json),
// which is correct for Production but was never meant to describe
// Staging -- Staging genuinely has migration 0048 (Google Calendar sync)
// live, Production genuinely does not (see production-baseline.ts's own
// header comment for that history). That made Staging's monthly
// restore-verify fail every month on a real, legitimate, EXPECTED
// difference, not a real drift bug. This file gives Staging its own,
// separately verified baseline so both jobs can pass correctly against
// their own real schemas, without ever loosening the comparison itself
// (lib/data-health/production-baseline.ts's compareSchemaObjects/
// stagingSchemaObjects/normalizeSchemaSql/PLATFORM_MANAGED_SCHEMA_OBJECTS
// are reused UNCHANGED below -- only the baseline DATA differs between
// the two files, never the comparison machinery).
//
// production-baseline/staging-schema-manifest.json was built from a
// direct, read-only query against the REAL, LIVE fundraising-os-
// staging-db (sqlite_schema, 2026-11-01) -- never a migration replay
// (generate-production-baseline.mjs's generateBaseline(), which Production's
// own manifest is built from, assumes every migration file it finds has
// actually been applied, in order, with no manual drift -- exactly the
// assumption that had already broken once for Production/migration 0048,
// so it was deliberately NOT reused here for Staging).
//
// ONE REAL FINDING from that live query, worth keeping visible here: migration
// 0048_google_calendar_sync.sql is only PARTIALLY applied to the real
// Staging database. `calendar_event_links`, `calendar_event_link_history`,
// `interactions.all_day`/`all_day_date`/`end_at`/`location`, and
// `users.calendar_sync_enabled` are all live and present in ddlTopology
// below -- but `trip_prospects.all_day`/`all_day_date` (the same
// migration's last two ALTER TABLE statements) are NOT present on live
// Staging. Because of this, 0048 is deliberately left OUT of
// STAGING_BASELINE_SOURCE_MIGRATIONS entirely (it would be misleading to
// claim it as either "fully applied" or "fully unapplied") -- the
// ddlTopology below is the actual source of truth for what the restore-
// verify comparison checks, and it already reflects reality exactly,
// independent of this bookkeeping list. If trip_prospects' two columns
// are later applied to Staging too, or 0048 is ever rolled back/
// completed/reconciled, this baseline needs its own refresh the same way
// -- a fresh live query, not a replay.
//
// manifest.topology (the detailed per-table column/foreign-key/index
// breakdown production-baseline.ts's sibling field carries) is
// intentionally omitted here -- see the manifest JSON's own `topology`
// placeholder field for why: nothing in this codebase reads it, only
// ddlTopology, and computing it live would need ~180 more D1 round trips
// for no actual consumer.
export const STAGING_BASELINE_LEVEL = manifest.baselineLevel;
export const STAGING_BASELINE_HASH = manifest.schemaHash;
export const STAGING_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const STAGING_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const STAGING_BASELINE_TABLES = STAGING_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);

// Same sanity-check shape as PRODUCTION_BASELINE_VERIFIED, adapted: this
// baseline's "level" is a live-query timestamp label, not a numbered
// bootstrap id, so there is no fixed string to compare against -- just
// confirm the hash/migration-count fields are well-formed and non-empty.
export const STAGING_BASELINE_VERIFIED = typeof STAGING_BASELINE_LEVEL === "string" && STAGING_BASELINE_LEVEL.length > 0 && /^[a-f0-9]{64}$/.test(STAGING_BASELINE_HASH) && STAGING_BASELINE_SOURCE_MIGRATIONS.length === 52;
