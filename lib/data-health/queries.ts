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
  WHERE i.user_id=? AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)`;

export const ORPHANED_REMINDERS_SQL = `SELECT COUNT(*) AS count FROM recommendations r
  LEFT JOIN donors d ON d.id=r.donor_id
  WHERE r.user_id=? AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)`;

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

export const LATEST_DONATION_REVIEW_SQL = `SELECT
  COALESCE(CASE WHEN json_valid(report_json) THEN json_extract(report_json,'$.results.unmatchedJlCodes') END,0) AS unmatched_jl_codes,
  COALESCE(CASE WHEN json_valid(report_json) THEN json_extract(report_json,'$.results.rowsRequiringReview') END,0) AS pending_assignments
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
