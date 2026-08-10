export const ACTIVE_DONORS_SQL = `SELECT COUNT(*) AS count FROM donors
  WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL`;

export const DUPLICATE_JL_CODES_SQL = `SELECT COUNT(*) AS count FROM (
  SELECT lower(trim(COALESCE(NULLIF(external_id,''), NULLIF(donor_code,'')))) AS jl_code
  FROM donors
  WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL
    AND external_source='JL Solutions' AND COALESCE(NULLIF(external_id,''), NULLIF(donor_code,'')) IS NOT NULL
  GROUP BY jl_code HAVING COUNT(*) > 1
)`;

// gifts has no owner column. Its foreign key prevents a missing donor; an
// owner-scoped orphan is therefore a gift left on this owner's archived alias.
export const ORPHANED_GIFTS_SQL = `SELECT COUNT(*) AS count FROM gifts g
  INNER JOIN donors d ON d.id=g.donor_id
  WHERE d.owner_user_id=? AND d.data_source='live' AND d.archived_at IS NOT NULL`;

export const ORPHANED_INTERACTIONS_SQL = `SELECT COUNT(*) AS count FROM interactions i
  LEFT JOIN donors d ON d.id=i.donor_id
  WHERE i.user_id=? AND i.source NOT LIKE 'archived:%'
    AND (d.id IS NULL OR d.data_source<>'sample')
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM data_health_repair_audits a
      WHERE a.user_id=i.user_id AND a.record_type='interaction' AND a.record_id=i.id
        AND a.action='dismiss_false_positive' AND COALESCE(a.previous_donor_id,'')=COALESCE(i.donor_id,''))`;

export const ORPHANED_REMINDERS_SQL = `SELECT COUNT(*) AS count FROM recommendations r
  LEFT JOIN donors d ON d.id=r.donor_id
  WHERE r.user_id=? AND r.status<>'dismissed'
    AND (d.id IS NULL OR d.data_source<>'sample')
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM data_health_repair_audits a
      WHERE a.user_id=r.user_id AND a.record_type='reminder' AND a.record_id=r.id
        AND a.action='dismiss_false_positive' AND COALESCE(a.previous_donor_id,'')=COALESCE(r.donor_id,''))`;

export const ORPHANED_PAYMENTS_SQL = `SELECT COUNT(*) AS count FROM jl_payment_assignments p
  LEFT JOIN giving_activities ga ON ga.id=p.pledge_activity_id
  LEFT JOIN donors d ON d.id=ga.donor_id
  WHERE p.user_id=? AND p.decision_type='apply_to_pledge'
    AND (p.pledge_activity_id IS NULL OR ga.id IS NULL OR ga.owner_user_id<>? OR ga.workspace_status<>'active'
      OR d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)`;

export const BROKEN_MERGE_REDIRECTS_SQL = `SELECT COUNT(*) AS count FROM donors d
  LEFT JOIN donors survivor ON survivor.id=d.merged_into_donor_id
  WHERE d.owner_user_id=? AND d.data_source='live' AND (
    (d.archived_at IS NOT NULL AND (d.merged_into_donor_id IS NULL OR survivor.id IS NULL OR survivor.owner_user_id<>? OR survivor.data_source<>'live' OR survivor.archived_at IS NOT NULL))
    OR (d.archived_at IS NULL AND d.merged_into_donor_id IS NOT NULL)
  )`;

export const GIVING_RECONCILIATION_SQL = `SELECT
  COALESCE(SUM(CASE WHEN ga.workspace_status='active' AND ga.record_origin='live'
    AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift') THEN COALESCE(ga.paid_cents,0) ELSE 0 END),0) AS source_total_cents,
  COALESCE(SUM(CASE WHEN ga.workspace_status='active' AND ga.record_origin='live'
    AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
    AND d.id IS NOT NULL AND d.owner_user_id=? AND d.data_source='live' AND d.archived_at IS NULL THEN COALESCE(ga.paid_cents,0) ELSE 0 END),0) AS linked_total_cents,
  COALESCE(SUM(CASE WHEN ga.record_origin='live' AND ga.workspace_status='active' AND (
    COALESCE(ga.committed_cents,0)<0 OR COALESCE(ga.paid_cents,0)<0 OR COALESCE(ga.balance_cents,0)<0
    OR (ga.category IN ('open_pledge','partially_paid_pledge') AND COALESCE(ga.balance_cents,0)<=0)
    OR (ga.category='completed_gift' AND COALESCE(ga.balance_cents,0)<>0)
  ) THEN 1 ELSE 0 END),0) AS invalid_rows
  FROM giving_activities ga LEFT JOIN donors d ON d.id=ga.donor_id
  WHERE ga.owner_user_id=?`;

export const DUPLICATE_GIVING_FINGERPRINTS_SQL = `SELECT COUNT(*) AS count FROM (
  SELECT external_source,source_fingerprint FROM giving_activities
  WHERE owner_user_id=? AND record_origin='live' AND workspace_status='active'
  GROUP BY external_source,source_fingerprint HAVING COUNT(*)>1
)`;

// Deliberately reports only unmatched JL Codes now. This used to also
// extract results.rowsRequiringReview as "pending_assignments" -- that
// field is a completed import's frozen, point-in-time review-row count and
// was never specific to payment/pledge decisions in the first place (see
// jl-donation-review.ts). A completed import can never have a genuinely
// pending pledge assignment: the commit route rejects any unresolved
// payment decision before writing anything. Real pending-assignment state
// is computed instead from active draft sessions -- see
// IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL below.
export const LATEST_DONATION_REVIEW_SQL = `SELECT
  COALESCE(CASE WHEN json_valid(report_json) THEN json_extract(report_json,'$.results.unmatchedJlCodes') END,0) AS unmatched_jl_codes
  FROM data_imports
  WHERE user_id=? AND status='completed' AND json_valid(report_json)
    AND json_extract(report_json,'$.profile')='JL Solutions Donations'
  ORDER BY completed_at DESC,created_at DESC LIMIT 1`;

export const FAILED_IMPORTS_SQL = `SELECT COUNT(*) AS count FROM data_imports
  WHERE user_id=? AND status NOT IN ('completed','undone')`;

export const REFRESH_STATE_SQL = `SELECT last_household_refresh_at,last_donation_refresh_at
  FROM jl_refresh_state WHERE user_id=? LIMIT 1`;

export const LAST_BACKUP_SQL = `SELECT MAX(created_at) AS created_at FROM workspace_backup_audits
  WHERE user_id=?`;

// Every review-draft session this owner has, regardless of status --
// callers distinguish "active draft" (status='draft', unexpired -- where a
// pending payment decision or unresolved review can still exist) from
// "committed" (where only an explicit review_later choice is still
// actionable, via countReviewLaterDecisions) themselves in JS, the same way
// countReviewLaterDecisions/countPendingPaymentDecisions already parse
// decisions_json rather than querying into it.
export const IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL = `SELECT status, decisions_json, expires_at
  FROM import_preview_sessions WHERE owner_user_id=?`;

// Actual fundraising business records -- distinct from BUSINESS_DATA_COUNT_SQL
// / FUNDRAISING_DATA_COUNT_SQL in production-baseline.ts (which intentionally
// stay untouched: the backup-safety gate and rehearsal scripts depend on
// their conservative, audit-inclusive definition). This is used only to
// display a meaningful breakdown on the independent-staging "Business data"
// card, which must never conflate donors/gifts with import batches, change
// audits, or draft-session bookkeeping.
export const BUSINESS_RECORD_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL) AS donors,
  (SELECT COUNT(*) FROM giving_activities WHERE owner_user_id=? AND record_origin='live' AND workspace_status='active') AS giving_activities,
  (SELECT COUNT(*) FROM interactions WHERE user_id=?) AS interactions,
  (SELECT COUNT(*) FROM recommendations WHERE user_id=?) AS reminders`;
