import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { buildImportPreview, FIELD_LABELS, type ColumnMapping, type ImportField, type ImportRow } from "../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../lib/import/jl-solutions";
import { matchJlDonors, sourceSnapshot, type ExistingJlDonor } from "../../../lib/import/jl-match";
import { logger } from "../../../lib/logger";

type ImportRequest = {
  fileName?: string;
  fileHash?: string;
  rows?: ImportRow[];
  mapping?: ColumnMapping;
  updateExisting?: boolean;
  mode?: "first" | "refresh";
};

const allowedFields = new Set<ImportField | "ignore">(["ignore", ...Object.keys(FIELD_LABELS) as ImportField[]]);

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

  const userId = `user_${user.email.toLowerCase()}`;
  const existing = await env.DB.prepare("SELECT id FROM data_imports WHERE file_hash = ? LIMIT 1").bind(fileHash).first<{ id: string }>();
  if (existing) return Response.json({ error: "This file has already been imported", importId: existing.id }, { status: 409 });

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
    rejectedRows: preview.rejectedRows,
    warnings: preview.warnings,
  };

  const donorRows = preview.donors.map((donor) => ({ ...donor, now }));
  const giftRows = preview.gifts.map((gift) => ({ ...gift, now }));
  const interactionRows = preview.interactions.map((interaction) => ({ ...interaction, now, userId, source: `import:${importId}` }));
  const reminderRows = preview.reminders.map((reminder) => ({ ...reminder, now, userId }));
  const donorSql = body.updateExisting
    ? `INSERT INTO donors (id, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?) WHERE true
       ON CONFLICT(id) DO UPDATE SET donor_code = excluded.donor_code, display_name = excluded.display_name, spouse = excluded.spouse, email = excluded.email, phone = excluded.phone, address = excluded.address, updated_at = excluded.updated_at`
    : `INSERT OR IGNORE INTO donors (id, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`;

  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, user.email, user.displayName, now, now),
  ];

  if (jlDetected) {
    const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
    const existing = codes.length
      ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(codes)).all<ExistingJlDonor>()
      : { results: [] as ExistingJlDonor[] };
    const matches = matchJlDonors(preview.donors, existing.results);
    for (const match of matches) {
      const donor = match.donor;
      const contact = donor.contact!;
      if (!match.existing) {
        statements.push(env.DB.prepare(`INSERT INTO donors (id, donor_code, external_source, external_id, display_name, spouse, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot, created_at, updated_at)
          VALUES (?, ?, 'JL Solutions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(donor.id, donor.donorCode, donor.donorCode, donor.name, contact.spouseFirstName, donor.email, donor.phone, donor.address, contact.lastName, contact.primaryFirstName, contact.spouseFirstName, contact.primaryTitle, contact.spouseTitle, contact.alternateMobilePhone, contact.homePhone, contact.addressLine1, contact.city, contact.state, contact.postalCode, contact.country, JSON.stringify(sourceSnapshot(donor)), now, now));
      } else if (body.mode === "refresh") {
        const updates = Object.entries(match.safeUpdates);
        const assignments = updates.map(([field]) => `${field} = ?`);
        assignments.push("source_snapshot = ?", "updated_at = ?");
        statements.push(env.DB.prepare(`UPDATE donors SET ${assignments.join(", ")} WHERE id = ?`)
          .bind(...updates.map(([, value]) => value), JSON.stringify(sourceSnapshot(donor)), now, match.existing.id));
      }
    }
  } else {
    statements.push(env.DB.prepare(donorSql).bind(JSON.stringify(donorRows)));
  }

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
