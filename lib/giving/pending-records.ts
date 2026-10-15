// Shared insert logic for recording an unconfirmed gift/pledge, so the
// Trip Fundraising Results Dashboard's "record a new donation/pledge"
// action writes the EXACT SAME shape of row the standalone
// app/api/giving/pending[-pledge] endpoints do -- literally "the
// existing CRM financial workflow," not a parallel reimplementation.
//
// app/api/giving/pending/route.ts (the existing, already-tested,
// Production-bound pending_gift endpoint) is deliberately left with its
// own inline insert, completely untouched by this module -- refactoring
// it to call this shared helper was considered and rejected: it is a
// sensitive financial endpoint with its own existing structural test
// coverage (tests/donation-management.test.mjs), and this feature does
// not need to touch it to reuse its SHAPE. insertPendingGift below is a
// deliberate, intentional duplicate of that route's own insert (kept
// identical on purpose), used only by the new trip-sourced recording
// path. insertPendingPledge is the one this file's own sibling route
// (app/api/giving/pending-pledge/route.ts) and the trip path both call,
// since that route is new, so there is no existing-code risk to sharing it.

import { env } from "cloudflare:workers";
import { pendingGiftInput, pendingPledgeInput } from "./management.ts";

export type PendingRecordResult = { ok: true; activityId: string } | { ok: false; error: string };

async function activeDonor(userId: string, donorId: string): Promise<{ id: string; external_id: string | null; donor_code: string | null } | null> {
  return env.DB.prepare("SELECT id,external_id,donor_code FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1")
    .bind(donorId, userId).first<{ id: string; external_id: string | null; donor_code: string | null }>();
}

export async function insertPendingGift(userId: string, rawInput: unknown): Promise<PendingRecordResult> {
  const input = pendingGiftInput(rawInput);
  if (input.errors.length) return { ok: false, error: input.errors.join(" ") };
  const donor = await activeDonor(userId, input.donorId);
  if (!donor) return { ok: false, error: "Choose an active donor from your workspace." };
  const id = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO giving_activities
        (id,owner_user_id,donor_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,item_type,description,source_campaign,category,record_origin,workspace_status,private_note,source_snapshot,created_at,updated_at)
        VALUES (?,?,?,'Fundraising OS',?,?,?,?,0,0,'Pending gift',?,?,'pending_gift','live','active',?,'{}',?,?)`)
        .bind(id, userId, donor.id, donor.external_id || donor.donor_code || donor.id, `pending:${id}`, input.activityDate, input.amountCents, input.designation || null, input.designation || null, input.note || null, now, now),
      env.DB.prepare(`INSERT INTO giving_activity_management_audits
        (id,user_id,activity_id,action,next_donor_id,next_status,next_note,created_at)
        VALUES (?,?,?,'pending_created',?,'active',?,?)`).bind(auditId, userId, id, donor.id, input.note || null, now),
    ]);
    return { ok: true, activityId: id };
  } catch {
    return { ok: false, error: "The pending gift could not be recorded. No partial record was kept." };
  }
}

export async function insertPendingPledge(userId: string, rawInput: unknown): Promise<PendingRecordResult> {
  const input = pendingPledgeInput(rawInput);
  if (input.errors.length) return { ok: false, error: input.errors.join(" ") };
  const donor = await activeDonor(userId, input.donorId);
  if (!donor) return { ok: false, error: "Choose an active donor from your workspace." };
  const id = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO giving_activities
        (id,owner_user_id,donor_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,item_type,description,source_campaign,category,record_origin,workspace_status,private_note,source_snapshot,created_at,updated_at)
        VALUES (?,?,?,'Fundraising OS',?,?,?,?,0,?,'Pending pledge',?,?,'pending_pledge','live','active',?,'{}',?,?)`)
        .bind(id, userId, donor.id, donor.external_id || donor.donor_code || donor.id, `pending-pledge:${id}`, input.activityDate, input.amountCents, input.amountCents, input.designation || null, input.designation || null, input.note || null, now, now),
      env.DB.prepare(`INSERT INTO giving_activity_management_audits
        (id,user_id,activity_id,action,next_donor_id,next_status,next_note,created_at)
        VALUES (?,?,?,'pending_pledge_created',?,'active',?,?)`).bind(auditId, userId, id, donor.id, input.note || null, now),
    ]);
    return { ok: true, activityId: id };
  } catch {
    return { ok: false, error: "The pending pledge could not be recorded. No partial record was kept." };
  }
}
