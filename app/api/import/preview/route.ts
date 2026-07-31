import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { buildImportPreview, type ColumnMapping, type ImportRow } from "../../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../../lib/import/jl-solutions";
import { matchJlDonors, type ExistingJlDonor } from "../../../../lib/import/jl-match";

type PreviewRequest = { rows?: ImportRow[]; mapping?: ColumnMapping; fileHash?: string };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json() as PreviewRequest;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const fileHash = body.fileHash ?? "";
  if (!rows.length || rows.length > 25000 || !/^[a-f0-9]{64}$/.test(fileHash)) return Response.json({ error: "The preview could not be validated" }, { status: 422 });
  const columns = Object.keys(rows[0] ?? {});
  const jlDetected = isJlSolutionsExport(columns);
  const preview = jlDetected ? buildJlPreview(rows, fileHash) : buildImportPreview(rows, body.mapping ?? {}, fileHash);
  if (!jlDetected) return Response.json({ profile: "general", preview });

  const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
  const existing = codes.length
    ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(codes)).all<ExistingJlDonor>()
    : { results: [] as ExistingJlDonor[] };
  const matches = matchJlDonors(preview.donors, existing.results);
  const conflicts = matches.flatMap((match) => match.conflicts);
  return Response.json({
    profile: "jl-solutions",
    preview,
    jl: {
      households: preview.donors.length,
      newRelationships: matches.filter((match) => !match.existing).length,
      existingRelationships: matches.filter((match) => match.existing).length,
      recordsWithUpdates: matches.filter((match) => Object.keys(match.safeUpdates).length > 0).length,
      conflicts,
    },
  });
}
