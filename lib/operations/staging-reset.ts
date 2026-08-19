export const STAGING_RESET_CONFIRMATION = "RESET INDEPENDENT STAGING";

// onboarding_preferences tracks demo-data acknowledgement and import mode,
// not durable account configuration, so it resets alongside fundraising
// data. The owner's own `users` row is never touched by this routine.
export const STAGING_RESET_ONBOARDING_TABLE = "onboarding_preferences";

// Explicit, dependency-safe deletion order (children before the parents
// they reference), so this works without depending on foreign-key pragma
// support in the D1 Workers binding. A regression test asserts this list
// is exactly FUNDRAISING_DATA_TABLES (in some order), so a newly added
// fundraising table can never be silently skipped by this routine.
export const STAGING_RESET_TABLE_ORDER = [
  // No fundraising-table dependents; only reference `users`, which is kept.
  "data_health_repair_audits",
  "jl_refresh_state",
  "legacy_test_cleanup_audits",
  "sample_cleanup_audits",
  "workspace_backup_audits",
  // import_preview_session_chunks references import_preview_sessions.
  "import_preview_session_chunks",
  "import_preview_sessions",
  // Depend only on `interactions` or `donors`.
  "activity_status_audits",
  // References shared_activities, not interactions directly -- deleted here
  // (before shared_activities itself, further down) for the same
  // children-before-parents reason as activity_status_audits above.
  "shared_activity_recipient_audits",
  // ask_changes references ask_id (a real FK here, unlike yahrtzeit_id --
  // see db/schema.ts's askChanges comment), so it's deleted first. asks
  // references interactions (nullable, source_interaction_id) and donors,
  // so it's deleted before both of those, further down.
  "ask_changes",
  "asks",
  "donor_contact_audits",
  "donor_historical_context",
  "donor_merge_audits",
  "donor_views",
  "gift_acknowledgments",
  "gifts",
  "recommendations",
  "relationship_queue_dismissals",
  // yahrtzeit_changes references yahrtzeit_id (not FK-enforced, so a
  // deletion's audit row can outlive it), so it's deleted first.
  "yahrtzeit_changes",
  "yahrtzeits",
  // Same reasoning as yahrtzeit_changes/yahrtzeits above.
  "important_date_changes",
  "important_dates",
  // Donor Research (Stage A) -- depend only on `donors`/`users` and each
  // other. donor_research_finding_sources and donor_research_findings must
  // precede donor_research_runs (which they reference); donor_research_sources
  // has no donor_id at all (workspace-scoped, shared across donors) but is
  // still deleted here, after the join table that references it.
  "donor_research_finding_sources",
  "donor_research_findings",
  "donor_research_identity_candidates",
  "donor_research_pending_evidence",
  "donor_research_sources",
  "donor_research_runs",
  // Depend on `data_imports`, `donors`, and/or `giving_activities`.
  "jl_payment_assignment_audits",
  "jl_payment_assignments",
  "household_import_changes",
  "donation_import_rollback_audits",
  "giving_activity_import_changes",
  "giving_activity_management_audits",
  "household_import_rollback_audits",
  // Parents — deleted last, once everything referencing them is gone.
  // `donors` self-references itself (merged_into_donor_id), which is safe
  // once nothing else in this list still points at any donor row.
  "interactions",
  // References by interactions.shared_activity_id (and by
  // shared_activity_recipient_audits, already deleted above) -- deleted
  // once interactions is gone, same reasoning as every other parent here.
  "shared_activities",
  "giving_activities",
  "data_imports",
  "donors",
] as const;

export function buildStagingResetStatements(): string[] {
  return [...STAGING_RESET_TABLE_ORDER, STAGING_RESET_ONBOARDING_TABLE].map((table) => `DELETE FROM "${table}";`);
}

export type StagingResetAuthorization = { allowed: true } | { allowed: false; status: number; error: string };

// Pure and independently testable: the route wiring (cloudflare:workers env,
// getChatGPTUser) is a thin layer around this. Environment is checked first
// and returns 404 — not 401/403 — so the endpoint is completely invisible
// outside the independent staging environment, not merely unauthorized.
export function authorizeStagingReset(
  deploymentEnvironment: string,
  identityEmail: string | null,
  ownerEmail: string | null | undefined,
): StagingResetAuthorization {
  if (deploymentEnvironment !== "staging-independent") return { allowed: false, status: 404, error: "Not found." };
  if (!identityEmail) return { allowed: false, status: 401, error: "Authentication required." };
  if (!ownerEmail || identityEmail.toLowerCase() !== ownerEmail.toLowerCase()) {
    return { allowed: false, status: 403, error: "Only the configured staging owner can reset this environment." };
  }
  return { allowed: true };
}
