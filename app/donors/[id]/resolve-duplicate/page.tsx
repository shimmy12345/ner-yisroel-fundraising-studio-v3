import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { MERGE_DONOR_SELECT, type MergeDonorRow, type MergeFieldGroup } from "../../../../lib/donors/merge";
import { MergeExperience } from "./MergeExperience";

export const dynamic = "force-dynamic";
type Counts = { gifts: number; pledges: number; interactions: number; meetings: number; reminders: number; notes: number };
const value = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ");
async function counts(id: string, userId: string) { return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM gifts WHERE donor_id=?) gifts,(SELECT COUNT(*) FROM giving_activities WHERE donor_id=? AND owner_user_id=?) pledges,(SELECT COUNT(*) FROM interactions WHERE donor_id=? AND user_id=?) interactions,(SELECT COUNT(*) FROM interactions WHERE donor_id=? AND user_id=? AND type='meeting') meetings,(SELECT COUNT(*) FROM recommendations WHERE donor_id=? AND user_id=?) reminders,(SELECT COUNT(*) FROM interactions WHERE donor_id=? AND user_id=? AND type='note') notes`).bind(id,id,userId,id,userId,id,userId,id,userId,id,userId).first<Counts>(); }
function view(row: MergeDonorRow, linked: Counts) { return { id: row.id, name: row.display_name, primaryFirstName: row.primary_first_name, lastName: row.last_name, code: row.external_id || row.donor_code, fields: { name: value(row.display_name, row.primary_first_name, row.last_name), spouse: value(row.spouse || row.spouse_first_name, row.spouse_title), jlCode: row.external_id || row.donor_code || "", email: row.email || "", phones: value(row.phone, row.home_phone, row.alternate_mobile_phone), address: value(row.address_line_1 || row.address, row.city, row.state, row.postal_code, row.country), notes: row.contact_note || "" } as Record<MergeFieldGroup,string>, counts: linked }; }

export default async function ResolveDuplicatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ otherId?: string }> }) {
  const { id } = await params; const { otherId } = await searchParams;
  const identity = await requireChatGPTUser(`/donors/${encodeURIComponent(id)}/resolve-duplicate`); const profile = await ensureUserProfile(identity);
  const current = await env.DB.prepare(`SELECT ${MERGE_DONOR_SELECT} FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' LIMIT 1`).bind(id, profile.id).first<MergeDonorRow>();
  if (!current) notFound(); if (current.archived_at && current.merged_into_donor_id) redirect(`/donors/${encodeURIComponent(current.merged_into_donor_id)}`);
  const candidates = await env.DB.prepare("SELECT id,display_name,primary_first_name,last_name,COALESCE(external_id,donor_code) code FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL AND id<>? ORDER BY last_name COLLATE NOCASE,display_name COLLATE NOCASE").bind(profile.id,id).all<{id:string;display_name:string;primary_first_name:string|null;last_name:string|null;code:string|null}>();
  const other = otherId ? await env.DB.prepare(`SELECT ${MERGE_DONOR_SELECT} FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL AND id<>? LIMIT 1`).bind(otherId,profile.id,id).first<MergeDonorRow>() : null;
  const [currentCounts, otherCounts] = await Promise.all([counts(id,profile.id), other ? counts(other.id,profile.id) : Promise.resolve(null)]);
  return <AppShell active="donors"><MergeExperience current={view(current,currentCounts!)} other={other && otherCounts ? view(other,otherCounts) : null} donors={candidates.results.map((row)=>({id:row.id,name:row.display_name,primaryFirstName:row.primary_first_name,lastName:row.last_name,code:row.code}))} /></AppShell>;
}
