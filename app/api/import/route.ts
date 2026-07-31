import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { buildImportPreview, FIELD_LABELS, type ColumnMapping, type ImportField, type ImportRow } from "../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../lib/import/jl-solutions";
import { matchJlDonors, sourceSnapshot, type ExistingJlDonor } from "../../../lib/import/jl-match";
import { logger } from "../../../lib/logger";
import { buildJlDonationPreview, isJlDonationExport } from "../../../lib/import/jl-donations";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../lib/import/jl-donation-match";
import { chunkJsonRows } from "../../../lib/import/d1-json-chunks";
import { ensureUserProfile } from "../../../lib/auth/profile";

type ImportRequest = {
  fileName?: string;
  fileHash?: string;
  rows?: ImportRow[];
  mapping?: ColumnMapping;
  updateExisting?: boolean;
  mode?: "first" | "refresh";
};

const allowedFields = new Set<ImportField | "ignore">(["ignore", ...Object.keys(FIELD_LABELS) as ImportField[]]);

type FailureCategory = "unmatched_jl_codes" | "duplicate_records" | "invalid_dates" | "invalid_amounts" | "missing_required_fields" | "nonfinancial_entries" | "transaction_database_errors" | "unexpected_exceptions";
type RowFailure = { row: number; category: FailureCategory; reason: string };

function reviewCategory(reason: string | null): FailureCategory {
  if (/code|required/i.test(reason ?? "")) return "missing_required_fields";
  if (/date/i.test(reason ?? "")) return "invalid_dates";
  if (/amount|negative/i.test(reason ?? "")) return "invalid_amounts";
  return "unexpected_exceptions";
}

function safeDatabaseReason(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/string or blob too big|sqlite_toobig/.test(message)) return "D1 rejected an oversized bound JSON value (SQLITE_TOOBIG).";
  if (/foreign key/.test(message)) return "A matched JL household changed or was removed before the transaction completed.";
  if (/unique|constraint/.test(message)) return "The database rejected a duplicate donation fingerprint.";
  if (/no such table|no such column/.test(message)) return "The staging database schema is missing a required donation-import table or column.";
  if (/too (many|large)|limit|size/.test(message)) return "The validated donation batch exceeded a D1 transaction limit.";
  return "The database could not commit the validated donation batch.";
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: ImportRequest;
  try {
    body = await request.json() as ImportRequest;
  } catch {
    return Response.json({ error: "Invalid import request" }, { status: 400 });
  }

  const fileName = body.fileName?.trim() ?? "";
  const fileHash = body.fileHash?.trim().toLowerCase() ?? "";
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const mapping = body.mapping ?? {};
  if (!fileName || !/^[a-f0-9]{64}$/.test(fileHash) || !rows.length || rows.length > 25000) {
    return Response.json({ error: "The import file could not be validated" }, { status: 422 });
  }
  if (Object.values(mapping).some((field) => !allowedFields.has(field))) {
    return Response.json({ error: "The column mapping contains an unsupported field" }, { status: 422 });
  }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const existing = await env.DB.prepare("SELECT id FROM data_imports WHERE user_id = ? AND file_hash = ? LIMIT 1").bind(userId, fileHash).first<{ id: string }>();
  if (existing) {
    if (isJlDonationExport(Object.keys(rows[0] ?? {}))) return Response.json({ error: "This exact donation file has already been imported.", fatalError: null, importId: existing.id, databaseChangesMade: false, noChangesMade: true, rollbackCauses: ["duplicate_records"], validation: { totalRows: rows.length, passedRows: rows.length, failedRows: 0, duplicateRows: rows.length, nonfinancialRows: 0, firstErrors: [{ row: 0, category: "duplicate_records", reason: "The file fingerprint matches a completed import" }] }, rejectedRows: rows.map((_, index) => ({ row: index + 2, category: "duplicate_records", reason: "Skipped because this exact file was already imported" })), results: { validRows: rows.length, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: rows.length, rowsRequiringReview: 0, rejectedRows: rows.length, unmatchedJlCodes: 0, elapsedMs: 0 } }, { status: 409 });
    return Response.json({ error: "This file has already been imported", importId: existing.id }, { status: 409 });
  }

  if (isJlDonationExport(Object.keys(rows[0] ?? {}))) {
    const startedAt = Date.now();
    try {
    const donationPreview = await buildJlDonationPreview(rows);
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<MatchedHousehold>() : { results: [] as MatchedHousehold[] };
    const prior = fingerprints.length ? await env.DB.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category, source_snapshot FROM giving_activities WHERE owner_user_id = ? AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(fingerprints)).all<ExistingGivingActivity>() : { results: [] as ExistingGivingActivity[] };
    const match = matchJlDonationActivities(donationPreview, households.results, prior.results);
    const rowFailures: RowFailure[] = [
      ...donationPreview.duplicateRows.map((duplicate) => ({ row: duplicate.row, category: "duplicate_records" as const, reason: "Duplicate source row" })),
      ...match.unknownActivities.map((activity) => ({ row: activity.rowNumber, category: "unmatched_jl_codes" as const, reason: "JL Code does not match an imported household" })),
      ...match.reviewActivities.map((activity) => ({ row: activity.rowNumber, category: reviewCategory(activity.reviewReason), reason: activity.reviewReason ?? "Row requires review" })),
      ...match.nonfinancialActivities.map((activity) => ({ row: activity.rowNumber, category: "nonfinancial_entries" as const, reason: "Zero-dollar, complimentary, or included entry was excluded from giving history" })),
    ].sort((a, b) => a.row - b.row);
    const validation = { totalRows: rows.length, passedRows: match.matched.length, failedRows: match.unknownHousehold + match.needsReview, duplicateRows: donationPreview.duplicateRows.length, nonfinancialRows: match.nonfinancial, firstErrors: rowFailures.slice(0, 10) };
    if (!match.matched.length) {
      const rollbackCauses = [...new Set(rowFailures.map((failure) => failure.category))];
      return Response.json({ error: "No donation rows were eligible for import.", fatalError: null, databaseChangesMade: false, noChangesMade: true, rollbackCauses, validation, rejectedRows: rowFailures, results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: donationPreview.duplicateRows.length, rowsRequiringReview: match.needsReview, rejectedRows: rowFailures.length, unmatchedJlCodes: match.unknownHousehold, elapsedMs: Date.now() - startedAt } }, { status: 422 });
    }
    const now = Math.floor(Date.now() / 1000);
    const importId = crypto.randomUUID();
    const liveHouseholds = await env.DB.prepare("SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live'").bind(userId).all<{ id: string }>();
    const householdsWithGiving = await env.DB.prepare("SELECT DISTINCT donor_id AS id FROM giving_activities WHERE owner_user_id = ? AND category NOT IN ('needs_review','nonfinancial_entry')").bind(userId).all<{ id: string }>();
    const givingDonorIds = new Set([...householdsWithGiving.results.map((item) => item.id), ...match.matched.map((item) => item.donorId)]);
    const householdsWithoutGivingHistory = liveHouseholds.results.filter((item) => !givingDonorIds.has(item.id)).length;
    const results = { validRows: match.matched.length, householdsMatched: new Set(match.matched.map((activity) => activity.donorId)).size, newHouseholds: 0, giftsImported: match.newActivities.length, giftsUpdated: match.proposedUpdates.length, duplicateRowsSkipped: donationPreview.duplicateRows.length + match.alreadyImported, rowsRequiringReview: match.needsReview, rejectedRows: rowFailures.length, unmatchedJlCodes: match.unknownHousehold, elapsedMs: 0 };
    const report = { importId, fileName, completedAt: new Date(now * 1000).toISOString(), profile: "JL Solutions Donations", databaseChangesMade: true, fatalError: null, mode: prior.results.length ? "refresh" : "first", firstRelationshipId: match.matched[0]?.donorId ?? null, imported: { donors: 0, gifts: match.newActivities.length, interactions: 0, reminders: 0 }, donation: { newActivities: match.newActivities.length, updatedPledges: match.proposedUpdates.length, unchanged: match.alreadyImported, unknownHousehold: match.unknownHousehold, needsReview: match.needsReview, nonfinancialExcluded: match.nonfinancial, duplicateSourceRows: donationPreview.duplicateRows.length }, reconciliation: { giftsMatchedByInternalDonorId: match.matched.length, unmatchedJlCodes: match.unknownHousehold, householdsWithoutGivingHistory, donationRowsRequiringReview: match.needsReview, todayAndAssistantRefresh: "next_request", userCreatedContentPreserved: true }, results, validation, rejectedRows: rowFailures, warnings: [match.unknownHousehold && `${match.unknownHousehold} rows have an unknown JL Code`, match.needsReview && `${match.needsReview} rows need review`, donationPreview.duplicateRows.length && `${donationPreview.duplicateRows.length} duplicate source rows were excluded`].filter(Boolean) };
    const activityRows = match.matched.map((activity) => ({ id: crypto.randomUUID(), ownerUserId: userId, donorId: activity.donorId, externalHouseholdId: activity.externalHouseholdId, fingerprint: activity.fingerprint, activityDate: activity.activityDate, committedCents: activity.committedCents, paidCents: activity.paidCents, balanceCents: activity.balanceCents, itemType: activity.itemType, description: activity.description, sourceCampaign: activity.sourceCampaign, category: activity.category, sourceSnapshot: JSON.stringify(activity.sourceValues), now }));
    const priorByFingerprint = new Map(prior.results.map((activity) => [activity.source_fingerprint, activity]));
    const changeRows = [...match.newActivities.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "insert", previousJson: null, now })), ...match.proposedUpdates.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "update", previousJson: JSON.stringify(priorByFingerprint.get(activity.fingerprint)), now }))];
    const activityStatements = chunkJsonRows(activityRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, source_campaign, category, source_snapshot, created_at, updated_at)
        SELECT json_extract(value,'$.id'), json_extract(value,'$.ownerUserId'), json_extract(value,'$.donorId'), 'JL Solutions', json_extract(value,'$.externalHouseholdId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.activityDate'), json_extract(value,'$.committedCents'), json_extract(value,'$.paidCents'), json_extract(value,'$.balanceCents'), json_extract(value,'$.itemType'), json_extract(value,'$.description'), json_extract(value,'$.sourceCampaign'), json_extract(value,'$.category'), json_extract(value,'$.sourceSnapshot'), json_extract(value,'$.now'), json_extract(value,'$.now') FROM json_each(?) WHERE true
        ON CONFLICT(owner_user_id, external_source, source_fingerprint) DO UPDATE SET paid_cents=excluded.paid_cents, balance_cents=excluded.balance_cents, category=excluded.category, source_snapshot=excluded.source_snapshot, updated_at=excluded.updated_at`).bind(chunk));
    const changeStatements = chunkJsonRows(changeRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activity_import_changes (import_id, source_fingerprint, change_type, previous_json, created_at) SELECT json_extract(value,'$.importId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.changeType'), json_extract(value,'$.previousJson'), json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(userId, user.email, user.displayName, now, now),
      ...activityStatements,
      env.DB.prepare("INSERT INTO data_imports (id, user_id, file_name, file_hash, status, update_existing, report_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?, ?)").bind(importId, userId, fileName, fileHash, JSON.stringify(report), now, now),
      env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(userId, now),
      ...changeStatements,
    ];
    try {
      await env.DB.batch(statements);
      results.elapsedMs = Date.now() - startedAt;
      logger.info("jl_donation_import_completed", { importId, userId, rows: rows.length, matched: match.matched.length, review: match.needsReview });
      return Response.json(report, { status: 201 });
    } catch (databaseError) {
      const reason = safeDatabaseReason(databaseError);
      const databaseFailure: RowFailure = { row: 0, category: "transaction_database_errors", reason };
      logger.error("jl_donation_import_failed", new Error("Database transaction failed"), { importId, userId, validated: match.matched.length });
      return Response.json({ error: reason, fatalError: reason, databaseChangesMade: false, noChangesMade: true, rollbackCauses: ["transaction_database_errors"], validation: { ...validation, firstErrors: [databaseFailure, ...validation.firstErrors].slice(0, 10) }, rejectedRows: [...match.matched.map((activity) => ({ row: activity.rowNumber, category: "transaction_database_errors" as const, reason: "Validated row was not written because the database transaction failed" })), ...rowFailures], results: { ...results, giftsImported: 0, giftsUpdated: 0, rejectedRows: match.matched.length + rowFailures.length, elapsedMs: Date.now() - startedAt } }, { status: 500 });
    }
    } catch (unexpectedError) {
      logger.error("jl_donation_import_unexpected", new Error("Unexpected import exception"), { userId, rows: rows.length });
      const failure: RowFailure = { row: 0, category: "unexpected_exceptions", reason: "An unexpected exception occurred while preparing the donation import." };
      return Response.json({ error: failure.reason, fatalError: failure.reason, databaseChangesMade: false, noChangesMade: true, rollbackCauses: ["unexpected_exceptions"], validation: { totalRows: rows.length, passedRows: 0, failedRows: rows.length, duplicateRows: 0, nonfinancialRows: 0, firstErrors: [failure] }, rejectedRows: rows.map((_, index) => ({ row: index + 2, category: "unexpected_exceptions" as const, reason: "Row was not written because import preparation failed" })), results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: 0, rowsRequiringReview: rows.length, rejectedRows: rows.length, unmatchedJlCodes: 0, elapsedMs: Date.now() - startedAt } }, { status: 500 });
    }
  }

  const jlDetected = isJlSolutionsExport(Object.keys(rows[0] ?? {}));
  const preview = jlDetected ? buildJlPreview(rows, fileHash) : buildImportPreview(rows, mapping, fileHash);
  if (!preview.donors.length) return Response.json({ error: "No valid donors were found" }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  const importId = crypto.randomUUID();
  const report = {
    importId,
    fileName,
    completedAt: new Date(now * 1000).toISOString(),
    updateExisting: Boolean(body.updateExisting),
    profile: jlDetected ? "JL Solutions" : "General spreadsheet",
    mode: jlDetected ? (body.mode === "refresh" ? "refresh" : "first") : "first",
    firstRelationshipId: preview.donors[0]?.id ?? null,
    imported: {
      donors: preview.donors.length,
      gifts: preview.gifts.length,
      interactions: preview.interactions.length,
      reminders: preview.reminders.length,
    },
    reconciliation: { giftsMatchedByInternalDonorId: preview.gifts.length, unmatchedJlCodes: 0, householdsWithoutGivingHistory: Math.max(0, preview.donors.length - new Set(preview.gifts.map((gift) => gift.donorId)).size), donationRowsRequiringReview: preview.rejectedRows.length, todayAndAssistantRefresh: "next_request", userCreatedContentPreserved: true },
    rejectedRows: preview.rejectedRows,
    warnings: preview.warnings,
  };

  const ownedIds = new Map(preview.donors.map((donor) => [donor.id, crypto.randomUUID()]));
  const donorRows = preview.donors.map((donor) => ({ ...donor, id: ownedIds.get(donor.id), ownerUserId: userId, now }));
  const giftRows = preview.gifts.map((gift) => ({ ...gift, donorId: ownedIds.get(gift.donorId), now }));
  const interactionRows = preview.interactions.map((interaction) => ({ ...interaction, donorId: ownedIds.get(interaction.donorId), now, userId, source: `import:${importId}` }));
  const reminderRows = preview.reminders.map((reminder) => ({ ...reminder, donorId: ownedIds.get(reminder.donorId), now, userId }));
  const donorSql = body.updateExisting
    ? `INSERT INTO donors (id, owner_user_id, data_source, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.ownerUserId'), 'live', json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?) WHERE true
       ON CONFLICT(owner_user_id, donor_code) DO UPDATE SET display_name = excluded.display_name, spouse = excluded.spouse, email = excluded.email, phone = excluded.phone, address = excluded.address, updated_at = excluded.updated_at`
    : `INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.ownerUserId'), 'live', json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`;

  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, user.email, user.displayName, now, now),
  ];

  if (jlDetected) {
    const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
    const existing = codes.length
      ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<ExistingJlDonor>()
      : { results: [] as ExistingJlDonor[] };
    const matches = matchJlDonors(preview.donors, existing.results);
    for (const match of matches) {
      const donor = match.donor;
      const contact = donor.contact!;
      if (!match.existing) {
        const donorId = crypto.randomUUID();
        ownedIds.set(donor.id, donorId);
        statements.push(env.DB.prepare(`INSERT INTO donors (id, owner_user_id, data_source, donor_code, external_source, external_id, display_name, spouse, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot, created_at, updated_at)
          VALUES (?, ?, 'live', ?, 'JL Solutions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(donorId, userId, donor.donorCode, donor.donorCode, donor.name, contact.spouseFirstName, donor.email, donor.phone, donor.address, contact.lastName, contact.primaryFirstName, contact.spouseFirstName, contact.primaryTitle, contact.spouseTitle, contact.alternateMobilePhone, contact.homePhone, contact.addressLine1, contact.city, contact.state, contact.postalCode, contact.country, JSON.stringify(sourceSnapshot(donor)), now, now));
      } else if (body.mode === "refresh") {
        const updates = Object.entries(match.safeUpdates);
        const assignments = updates.map(([field]) => `${field} = ?`);
        assignments.push("source_snapshot = ?", "updated_at = ?");
        ownedIds.set(donor.id, match.existing.id);
        statements.push(env.DB.prepare(`UPDATE donors SET ${assignments.join(", ")} WHERE id = ? AND owner_user_id = ? AND data_source = 'live'`)
          .bind(...updates.map(([, value]) => value), JSON.stringify(sourceSnapshot(donor)), now, match.existing.id, userId));
      }
    }
  } else {
    statements.push(env.DB.prepare(donorSql).bind(JSON.stringify(donorRows)));
  }
  report.firstRelationshipId = ownedIds.get(preview.donors[0]?.id ?? "") ?? report.firstRelationshipId;

  statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO gifts (id, donor_id, amount_cents, fund, received_at, note, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.amountCents'), json_extract(value, '$.designation'), json_extract(value, '$.date'), json_extract(value, '$.note'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(giftRows)),
    env.DB.prepare(`INSERT OR IGNORE INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.userId'), json_extract(value, '$.type'), json_extract(value, '$.date'), json_extract(value, '$.notes'), json_extract(value, '$.source'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(interactionRows)),
    env.DB.prepare(`INSERT OR IGNORE INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.userId'), json_extract(value, '$.title'), COALESCE(json_extract(value, '$.notes'), 'Imported reminder'), 100, 'open', json_extract(value, '$.dueDate'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(reminderRows)),
    env.DB.prepare("INSERT INTO data_imports (id, user_id, file_name, file_hash, status, update_existing, report_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)")
      .bind(importId, userId, fileName, fileHash, body.updateExisting ? 1 : 0, JSON.stringify(report), now, now),
    env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(userId, now),
  );

  try {
    await env.DB.batch(statements);
    logger.info("data_import_completed", { importId, userId, donors: preview.donors.length, rejected: preview.rejectedRows.length });
    return Response.json(report, { status: 201 });
  } catch (error) {
    logger.error("data_import_failed", new Error("Database transaction failed"), { importId, userId });
    return Response.json({ error: "Nothing was imported. Resolve the reported conflict and try again." }, { status: 500 });
  }
}
