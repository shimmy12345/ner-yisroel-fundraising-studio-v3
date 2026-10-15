// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md).
// The one D1-touching module for this feature, matching the established
// split (lib/relationships/meeting-brief.ts vs. meeting-brief-model.ts):
// every rule/validation/status-string decision lives in the pure
// trip-model.ts; this file only ever reads/writes D1 and calls that pure
// logic, same convention app/api/asks/route.ts and meeting-brief.ts both
// already follow.

import { env } from "cloudflare:workers";
import { loadMeetingBrief } from "./meeting-brief.ts";
import { regionsForCityState, travelRegionById, type TravelRegionId } from "./travel-regions.ts";
import { zonedTimeToUtc } from "../workspace/local-time.ts";
import { insertPendingGift, insertPendingPledge } from "../giving/pending-records.ts";
import {
  buildSuggestionSnapshot, findCrossTripConflicts, findNewlyMatchingDonors, parseLocalDateTimeInput,
  statusRequiresInteraction, timezoneForState, tripCancelledInteractionSource, tripCompletedInteractionSource,
  tripMeetingInteractionId, tripScheduledInteractionSource, validateMeetingCompletion, validateMeetingScheduling,
  type AddedMethod, type CrossTripConflict, type RegionCandidateDonor, type TripProspectStatus, type TripStatus,
} from "./trip-model.ts";

// Independent-review correction (2026-10-15): resolves a `datetime-local`
// input value into a real UTC epoch using the PROSPECT'S OWN donor state
// to pick the destination timezone (timezoneForState()), falling back to
// the fundraiser's own home timezone only when the donor has none on
// file -- never the browser's ambient timezone. Returns null for a
// malformed input string; the caller turns that into a clear validation
// error rather than guessing. See trip-model.ts's own header comment on
// parseLocalDateTimeInput() for why a strict regex parse (never `new
// Date()`) is what makes this safe to call with untrusted request-body
// text at all.
async function resolveMeetingEpoch(donorId: string, localDateTime: unknown, fallbackTimezone: string): Promise<number | null> {
  const fields = parseLocalDateTimeInput(localDateTime);
  if (!fields) return null;
  const donor = await env.DB.prepare("SELECT state FROM donors WHERE id = ?").bind(donorId).first<{ state: string | null }>();
  const timezone = timezoneForState(donor?.state ?? null, fallbackTimezone);
  const utc = zonedTimeToUtc(fields.year, fields.month, fields.day, fields.hour, fields.minute, timezone);
  return Math.floor(utc.getTime() / 1000);
}

// A deliberately small, fixed concurrency limit for the one-time,
// trip-creation auto-suggestion fan-out (Section B): the largest single
// approved region today (Baltimore & Maryland suburbs, 57 real donors --
// see docs/AI-HANDOFF.md's Phase 1 audit) would otherwise issue ~57
// concurrent loadMeetingBrief() calls, each itself ~14 parallel D1
// queries -- conservative batching avoids relying on D1's own concurrent-
// connection ceiling for a single Worker invocation. This is the only
// place in this module that needs it; every other operation here touches
// at most one donor.
async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type DonorRow = { id: string; display_name: string; city: string | null; state: string | null };

async function liveOwnedDonors(userId: string): Promise<DonorRow[]> {
  const result = await env.DB.prepare("SELECT id, display_name, city, state FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(userId).all<DonorRow>();
  return result.results;
}

export type TripListItem = { id: string; name: string; destinationRegionLabel: string | null; startDate: number; endDate: number; status: TripStatus; prospectCount: number };

export async function listTrips(userId: string): Promise<TripListItem[]> {
  const result = await env.DB.prepare(`SELECT t.id, t.name, t.destination_region_label, t.start_date, t.end_date, t.status,
      (SELECT COUNT(*) FROM trip_prospects WHERE trip_id = t.id) AS prospect_count
    FROM trips t WHERE t.owner_user_id = ? ORDER BY t.start_date DESC`).bind(userId).all<{ id: string; name: string; destination_region_label: string | null; start_date: number; end_date: number; status: TripStatus; prospect_count: number }>();
  return result.results.map((row) => ({ id: row.id, name: row.name, destinationRegionLabel: row.destination_region_label, startDate: row.start_date, endDate: row.end_date, status: row.status, prospectCount: row.prospect_count }));
}

export type CreateTripInput = { name: string; destinationRegionId: TravelRegionId | null; startDate: number; endDate: number; goalCents: number | null; notes: string | null };

// Creates the trip row, then (when a destination region was chosen)
// auto-populates trip_prospects for every live, owned, non-archived
// donor currently matching it -- via regionsForCityState(), the EXACT
// same function the donor directory's own Travel Region filter uses,
// never a reimplementation. Each prospect's suggested_reason/
// suggested_score/suggested_generated_at is a snapshot of the real,
// unmodified loadMeetingBrief()'s own `.recommendation` at this exact
// moment -- never a separate trip-prioritization score. This is the
// ONLY place this auto-population ever runs; a donor added to the region
// afterward is surfaced only via findNewlyMatchingProspects() below,
// never inserted here automatically.
export async function createTrip(userId: string, input: CreateTripInput, timezone: string, now: number): Promise<{ tripId: string; autoAddedCount: number }> {
  const tripId = crypto.randomUUID();
  const region = input.destinationRegionId ? travelRegionById(input.destinationRegionId) : null;
  await env.DB.prepare(`INSERT INTO trips (id, owner_user_id, name, destination_region_id, destination_region_label, start_date, end_date, fundraising_goal_cents, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)`)
    .bind(tripId, userId, input.name, region?.id ?? null, region?.label ?? null, input.startDate, input.endDate, input.goalCents, input.notes, now, now).run();

  if (!region) return { tripId, autoAddedCount: 0 };

  const donors = await liveOwnedDonors(userId);
  const matching = donors.filter((donor) => regionsForCityState(donor.city, donor.state).includes(region.id));
  if (matching.length === 0) return { tripId, autoAddedCount: 0 };

  const briefs = await mapWithConcurrencyLimit(matching, 8, (donor) => loadMeetingBrief(userId, donor.id, timezone, now));
  const statements = matching.map((donor, index) => {
    const snapshot = buildSuggestionSnapshot(briefs[index]?.recommendation ?? null, now);
    return env.DB.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, suggested_reason, suggested_score, suggested_generated_at, created_at, updated_at)
        VALUES (?, ?, ?, 'auto_region', 'not_contacted', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), tripId, donor.id, snapshot.reason, snapshot.score, snapshot.generatedAt, now, now);
  });
  await env.DB.batch(statements);
  return { tripId, autoAddedCount: matching.length };
}

export type TripRecord = { id: string; name: string; destinationRegionId: TravelRegionId | null; destinationRegionLabel: string | null; startDate: number; endDate: number; goalCents: number | null; notes: string | null; status: TripStatus; createdAt: number; updatedAt: number };

export async function getTrip(userId: string, tripId: string): Promise<TripRecord | null> {
  const row = await env.DB.prepare(`SELECT id, name, destination_region_id, destination_region_label, start_date, end_date, fundraising_goal_cents, notes, status, created_at, updated_at
      FROM trips WHERE id = ? AND owner_user_id = ?`).bind(tripId, userId)
    .first<{ id: string; name: string; destination_region_id: string | null; destination_region_label: string | null; start_date: number; end_date: number; fundraising_goal_cents: number | null; notes: string | null; status: TripStatus; created_at: number; updated_at: number }>();
  if (!row) return null;
  return { id: row.id, name: row.name, destinationRegionId: row.destination_region_id as TravelRegionId | null, destinationRegionLabel: row.destination_region_label, startDate: row.start_date, endDate: row.end_date, goalCents: row.fundraising_goal_cents, notes: row.notes, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

export type TripProspectRecord = {
  id: string; donorId: string; donorDisplayName: string; donorCity: string | null; donorState: string | null;
  addedMethod: AddedMethod; status: TripProspectStatus;
  suggestedReason: string | null; suggestedScore: number | null; suggestedGeneratedAt: number | null;
  manualRank: number | null; meetingAt: number | null; meetingLocation: string | null; nextAction: string | null; trip_notes: string | null;
  linkedInteractionId: string | null; crossTripConflicts: CrossTripConflict[];
};

export async function listTripProspects(userId: string, tripId: string): Promise<TripProspectRecord[]> {
  const prospectRows = await env.DB.prepare(`SELECT tp.id, tp.donor_id, d.display_name AS donor_display_name, d.city AS donor_city, d.state AS donor_state,
        tp.added_method, tp.status, tp.suggested_reason, tp.suggested_score, tp.suggested_generated_at, tp.manual_rank,
        tp.meeting_at, tp.meeting_location, tp.next_action, tp.trip_notes, tp.linked_interaction_id
      FROM trip_prospects tp JOIN donors d ON d.id = tp.donor_id
      WHERE tp.trip_id = ? AND d.owner_user_id = ?
      ORDER BY (tp.manual_rank IS NULL), tp.manual_rank, tp.suggested_score IS NULL, tp.suggested_score DESC, d.display_name`)
    .bind(tripId, userId).all<{
      id: string; donor_id: string; donor_display_name: string; donor_city: string | null; donor_state: string | null;
      added_method: AddedMethod; status: TripProspectStatus; suggested_reason: string | null; suggested_score: number | null; suggested_generated_at: number | null;
      manual_rank: number | null; meeting_at: number | null; meeting_location: string | null; next_action: string | null; trip_notes: string | null; linked_interaction_id: string | null;
    }>();
  if (prospectRows.results.length === 0) return [];

  const donorIds = [...new Set(prospectRows.results.map((row) => row.donor_id))];
  // Cross-trip conflicts (Section C): every OTHER trip's prospect row for
  // any donor on THIS trip, across every one of this owner's trips --
  // one query, not one per prospect.
  const conflictRows = await env.DB.prepare(`SELECT tp.donor_id, tp.trip_id, t.name AS trip_name, tp.status, tp.meeting_at
      FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
      WHERE t.owner_user_id = ? AND tp.trip_id != ? AND tp.donor_id IN (${donorIds.map(() => "?").join(",")})`)
    .bind(userId, tripId, ...donorIds).all<{ donor_id: string; trip_id: string; trip_name: string; status: TripProspectStatus; meeting_at: number | null }>();
  const rowsByDonor = new Map<string, Array<{ tripId: string; tripName: string; status: TripProspectStatus; meetingAt: number | null }>>();
  for (const row of conflictRows.results) {
    const list = rowsByDonor.get(row.donor_id) ?? [];
    list.push({ tripId: row.trip_id, tripName: row.trip_name, status: row.status, meetingAt: row.meeting_at });
    rowsByDonor.set(row.donor_id, list);
  }
  // The SQL above already excludes this trip's own rows (`tp.trip_id !=
  // ?`), but findCrossTripConflicts() still takes `excludeTripId`
  // explicitly -- the one real filtering decision (which STATUSES count
  // as a conflict) stays in the pure, unit-tested function, never
  // duplicated here.
  const conflictsByDonor = new Map<string, CrossTripConflict[]>([...rowsByDonor.entries()].map(([donorId, rows]) => [donorId, findCrossTripConflicts(rows, tripId)]));

  return prospectRows.results.map((row) => ({
    id: row.id, donorId: row.donor_id, donorDisplayName: row.donor_display_name, donorCity: row.donor_city, donorState: row.donor_state,
    addedMethod: row.added_method, status: row.status, suggestedReason: row.suggested_reason, suggestedScore: row.suggested_score, suggestedGeneratedAt: row.suggested_generated_at,
    manualRank: row.manual_rank, meetingAt: row.meeting_at, meetingLocation: row.meeting_location, nextAction: row.next_action, trip_notes: row.trip_notes,
    linkedInteractionId: row.linked_interaction_id, crossTripConflicts: conflictsByDonor.get(row.donor_id) ?? [],
  }));
}

// Section C's "new prospects available" panel -- always computed live,
// never cached/materialized, and NEVER inserted into trip_prospects on
// its own. A donor is offered here the moment they exist in `donors`
// and match the trip's region AND are not already tracked on this trip
// -- whether they are brand new, just imported, or just had their
// address corrected, with no backfill or migration step of any kind.
export async function findNewlyMatchingProspects(userId: string, tripId: string): Promise<RegionCandidateDonor[]> {
  const trip = await getTrip(userId, tripId);
  if (!trip?.destinationRegionId) return [];
  const [donors, trackedRows] = await Promise.all([
    liveOwnedDonors(userId),
    env.DB.prepare("SELECT donor_id FROM trip_prospects WHERE trip_id = ?").bind(tripId).all<{ donor_id: string }>(),
  ]);
  const tracked = new Set(trackedRows.results.map((row) => row.donor_id));
  const candidates: RegionCandidateDonor[] = donors.map((donor) => ({ id: donor.id, displayName: donor.display_name, city: donor.city, state: donor.state }));
  return findNewlyMatchingDonors(candidates, trip.destinationRegionId, tracked);
}

export type AddProspectResult = { ok: true; prospectId: string } | { ok: false; reason: "donor_not_found" | "already_on_trip" };

// Manual add (Section C) -- also used to pull a donor in from the
// "newly matching" panel above, via the SAME explicit, one-at-a-time
// action; never auto-inserted. Computes the SAME suggestion snapshot a
// freshly-added donor would get via loadMeetingBrief() regardless of
// addedMethod -- it is still real, current CRM evidence either way; only
// `added_method` itself records how the donor was added.
export async function addManualProspect(userId: string, tripId: string, donorId: string, addedMethod: AddedMethod, timezone: string, now: number): Promise<AddProspectResult> {
  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(donorId, userId).first<{ id: string }>();
  if (!donor) return { ok: false, reason: "donor_not_found" };
  const existing = await env.DB.prepare("SELECT id FROM trip_prospects WHERE trip_id = ? AND donor_id = ?").bind(tripId, donorId).first<{ id: string }>();
  if (existing) return { ok: false, reason: "already_on_trip" };

  const brief = await loadMeetingBrief(userId, donorId, timezone, now);
  const snapshot = buildSuggestionSnapshot(brief?.recommendation ?? null, now);
  const prospectId = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, suggested_reason, suggested_score, suggested_generated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'not_contacted', ?, ?, ?, ?, ?)`)
      .bind(prospectId, tripId, donorId, addedMethod, snapshot.reason, snapshot.score, snapshot.generatedAt, now, now).run();
  } catch {
    // UNIQUE(trip_id, donor_id) caught a race (two concurrent adds for
    // the same donor) that the pre-check above missed -- structurally
    // impossible to double-insert, matching every other UNIQUE-
    // constraint-as-the-real-guarantee pattern in this app.
    return { ok: false, reason: "already_on_trip" };
  }
  return { ok: true, prospectId };
}

// Removal (Section C): deletes only the trip_prospects row. Deliberately
// never touches the donor record, interactions, or any other trip's own
// prospect rows -- the owner's own explicit "without changing their CRM
// records" instruction. If the removed prospect had a real scheduled
// meeting (linked_interaction_id set, not yet completed), that
// interaction is left exactly as it is; cancelling an actual meeting is
// a status decision (see updateProspectStatus below), never an implicit
// side effect of removing it from this trip's list.
export async function removeProspect(userId: string, tripId: string, prospectId: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM trip_prospects WHERE id = ? AND trip_id = ? AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(prospectId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0;
}

type ExistingProspect = { id: string; donorId: string; status: TripProspectStatus; linkedInteractionId: string | null };

async function ownedProspect(userId: string, tripId: string, prospectId: string): Promise<ExistingProspect | null> {
  const row = await env.DB.prepare(`SELECT tp.id, tp.donor_id, tp.status, tp.linked_interaction_id
      FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
      WHERE tp.id = ? AND tp.trip_id = ? AND t.owner_user_id = ?`).bind(prospectId, tripId, userId)
    .first<{ id: string; donor_id: string; status: TripProspectStatus; linked_interaction_id: string | null }>();
  return row ? { id: row.id, donorId: row.donor_id, status: row.status, linkedInteractionId: row.linked_interaction_id } : null;
}

export type StatusUpdateResult = { ok: true } | { ok: false; reason: "not_found" | "conflict" | "confirmation_required" | "already_completed" | "invalid_meeting_time" };

// A simple status move -- not_contacted/contacted/meeting_requested/
// declined/unable_to_schedule. Never writes to `interactions` (Section
// D's explicit "must not automatically create false donor interactions"
// / "Contacted must not claim a completed interaction occurred"). If the
// prospect is moving AWAY from meeting_scheduled (to any status other
// than meeting_completed) and has a linked interaction still in its
// scheduled state, that interaction is cancelled (wrapped with the same
// `cancelled:` prefix the existing outcome route already uses) so it
// stops appearing as an upcoming meeting anywhere else in the CRM --
// directly satisfies "do not allow a cancelled or declined meeting to
// remain incorrectly represented as upcoming".
export async function setSimpleProspectStatus(userId: string, tripId: string, prospectId: string, nextStatus: TripProspectStatus, now: number): Promise<StatusUpdateResult> {
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  const statements = [];
  if (existing.status === "meeting_scheduled" && nextStatus !== "meeting_completed" && existing.linkedInteractionId) {
    const interaction = await env.DB.prepare("SELECT source FROM interactions WHERE id = ? AND user_id = ?").bind(existing.linkedInteractionId, userId).first<{ source: string }>();
    if (interaction && !interaction.source.startsWith("capture-completed:") && !interaction.source.startsWith("cancelled:")) {
      statements.push(env.DB.prepare("UPDATE interactions SET source = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(tripCancelledInteractionSource(interaction.source), now, existing.linkedInteractionId, userId));
    }
  }
  statements.push(env.DB.prepare("UPDATE trip_prospects SET status = ?, updated_at = ? WHERE id = ? AND status = ?").bind(nextStatus, now, prospectId, existing.status));
  const results = await env.DB.batch(statements) as unknown as Array<{ meta: { changes?: number } }>;
  if ((results.at(-1)?.meta.changes ?? 0) === 0) return { ok: false, reason: "conflict" };
  return { ok: true };
}

// "Scheduling a meeting may create a real scheduled interaction ...
// but only after explicit user confirmation" -- `confirmed` is the
// caller's own explicit flag from the request body, checked by the
// route before this is ever called; this function itself still refuses
// to proceed without it; the real write is idempotent (deterministic
// interaction id, ON CONFLICT DO UPDATE) so a retried request can never
// create a second interaction for the same prospect.
//
// Independent-review correction (2026-10-15): refuses once the prospect
// is already `meeting_completed`. Without this, re-selecting "Meeting
// Scheduled" on an already-completed prospect (reachable through the
// ordinary status dropdown, not just a crafted request) would silently
// overwrite the SAME linked interaction's `summary`/`source` back to a
// generic "scheduled" placeholder -- erasing the real completed
// meeting's own notes, not merely relabeling a status. Rescheduling
// before completion (declined -> scheduled, or scheduled -> a new time)
// is unaffected; only the completed -> scheduled direction is blocked.
// A fundraiser who genuinely needs a second, later meeting with the
// same donor on the same trip must remove and re-add the prospect
// (documented as a known MVP limitation, not silently worked around
// here) rather than risk this function ever discarding a real record
// of what already happened.
// `meetingAtLocal` is the exact, untrusted `<input type="datetime-local">`
// string from the request body -- resolved to a real UTC epoch via
// resolveMeetingEpoch() (the donor's own destination timezone, DST-safe,
// never the browser's ambient zone) before anything else runs.
export async function scheduleProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, location: string | null, confirmed: boolean, fallbackTimezone: string, now: number): Promise<StatusUpdateResult> {
  if (!confirmed) return { ok: false, reason: "confirmation_required" };
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "meeting_completed") return { ok: false, reason: "already_completed" };
  const meetingAt = await resolveMeetingEpoch(existing.donorId, meetingAtLocal, fallbackTimezone);
  if (meetingAt === null || !validateMeetingScheduling(meetingAt, now).ok) return { ok: false, reason: "invalid_meeting_time" };
  const interactionId = tripMeetingInteractionId(prospectId);
  const source = tripScheduledInteractionSource(tripId);
  const donor = await env.DB.prepare("SELECT display_name FROM donors WHERE id = ?").bind(existing.donorId).first<{ display_name: string }>();
  const summary = `Trip meeting scheduled with ${donor?.display_name ?? "donor"}.`;
  const statements = [
    env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
        VALUES (?, ?, ?, 'meeting', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET occurred_at = excluded.occurred_at, summary = excluded.summary, source = excluded.source, updated_at = excluded.updated_at`)
      .bind(interactionId, existing.donorId, userId, meetingAt, summary, source, now, now),
    env.DB.prepare("UPDATE trip_prospects SET status = 'meeting_scheduled', meeting_at = ?, meeting_location = ?, linked_interaction_id = ?, updated_at = ? WHERE id = ?")
      .bind(meetingAt, location, interactionId, now, prospectId),
  ];
  await env.DB.batch(statements);
  return { ok: true };
}

// "Marking a meeting Completed must require explicit confirmation of the
// outcome, including an actual meeting date and meaningful notes" --
// `meetingAt`/`notes` are already validated by the caller
// (trip-model.ts's validateMeetingCompletion) before this runs; this
// function additionally requires the same explicit `confirmed` flag as
// scheduling. Reuses the SAME linked interaction (upserted by id, exactly
// like scheduling above) when one already exists from a prior "Meeting
// Scheduled" step; creates one directly in the completed state when the
// fundraiser jumps straight to "Meeting Completed" without having
// scheduled it first (a real, legitimate case -- an impromptu meeting).
export async function completeProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, notes: string, confirmed: boolean, fallbackTimezone: string, now: number): Promise<StatusUpdateResult> {
  if (!confirmed) return { ok: false, reason: "confirmation_required" };
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  const meetingAt = await resolveMeetingEpoch(existing.donorId, meetingAtLocal, fallbackTimezone);
  if (meetingAt === null || !validateMeetingCompletion(meetingAt, notes, now).ok) return { ok: false, reason: "invalid_meeting_time" };
  const interactionId = existing.linkedInteractionId ?? tripMeetingInteractionId(prospectId);
  const originalSource = tripScheduledInteractionSource(tripId);
  const completedSource = tripCompletedInteractionSource(meetingAt, originalSource);
  const donor = await env.DB.prepare("SELECT display_name FROM donors WHERE id = ?").bind(existing.donorId).first<{ display_name: string }>();
  const summary = `Trip meeting with ${donor?.display_name ?? "donor"}.\n${notes}`;
  const statements = [
    env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
        VALUES (?, ?, ?, 'meeting', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET occurred_at = excluded.occurred_at, summary = excluded.summary, source = excluded.source, updated_at = excluded.updated_at`)
      .bind(interactionId, existing.donorId, userId, meetingAt, summary, completedSource, now, now),
    env.DB.prepare("UPDATE trip_prospects SET status = 'meeting_completed', meeting_at = ?, linked_interaction_id = ?, updated_at = ? WHERE id = ?")
      .bind(meetingAt, interactionId, now, prospectId),
  ];
  await env.DB.batch(statements);
  return { ok: true };
}

export type ProspectFieldUpdate = { tripNotes?: string | null; nextAction?: string | null; manualRank?: number | null; meetingLocation?: string | null };

export async function updateProspectFields(userId: string, tripId: string, prospectId: string, update: ProspectFieldUpdate, now: number): Promise<boolean> {
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return false;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if ("tripNotes" in update) { sets.push("trip_notes = ?"); values.push(update.tripNotes ?? null); }
  if ("nextAction" in update) { sets.push("next_action = ?"); values.push(update.nextAction ?? null); }
  if ("manualRank" in update) { sets.push("manual_rank = ?"); values.push(update.manualRank ?? null); }
  if ("meetingLocation" in update) { sets.push("meeting_location = ?"); values.push(update.meetingLocation ?? null); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  values.push(now);
  await env.DB.prepare(`UPDATE trip_prospects SET ${sets.join(", ")} WHERE id = ?`).bind(...values, prospectId).run();
  return true;
}

export async function updateTrip(userId: string, tripId: string, update: { name?: string; status?: TripStatus; goalCents?: number | null; notes?: string | null; startDate?: number; endDate?: number }, now: number): Promise<boolean> {
  const existing = await getTrip(userId, tripId);
  if (!existing) return false;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (update.name !== undefined) { sets.push("name = ?"); values.push(update.name); }
  if (update.status !== undefined) { sets.push("status = ?"); values.push(update.status); }
  if (update.goalCents !== undefined) { sets.push("fundraising_goal_cents = ?"); values.push(update.goalCents); }
  if (update.notes !== undefined) { sets.push("notes = ?"); values.push(update.notes); }
  if (update.startDate !== undefined) { sets.push("start_date = ?"); values.push(update.startDate); }
  if (update.endDate !== undefined) { sets.push("end_date = ?"); values.push(update.endDate); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  values.push(now);
  await env.DB.prepare(`UPDATE trips SET ${sets.join(", ")} WHERE id = ? AND owner_user_id = ?`).bind(...values, tripId, userId).run();
  return true;
}

// Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
// This section is the only place this file writes to giving_activities
// (via the shared lib/giving/pending-records.ts helpers, reused
// verbatim, never a parallel insert) or to the new, additive
// trip_financial_attributions link table (drizzle/0046) -- it NEVER
// writes to committed_cents/paid_cents/balance_cents on an EXISTING
// giving_activities row; attributing/removing only changes which trip a
// record is linked to, never the financial record itself.

export type EligibleGivingActivity = {
  id: string; category: string; workspaceStatus: string;
  committedCents: number | null; paidCents: number | null; balanceCents: number | null;
  activityDate: number | null; description: string | null;
};

// A donor's own giving_activities rows that are real financial records
// (REAL_COMMITMENT_CATEGORIES) or an unconfirmed pending gift/pledge, and
// are NOT already actively attributed to any trip (the trip_financial_
// attributions unique-partial-index is the actual structural guard; this
// query exists only so the "associate existing" picker never even offers
// an already-attributed record). owner_user_id-scoped, matching every
// other donor-financial query in this codebase.
export async function listEligibleGivingActivitiesForDonor(userId: string, donorId: string): Promise<EligibleGivingActivity[]> {
  const result = await env.DB.prepare(`SELECT ga.id, ga.category, ga.workspace_status, ga.committed_cents, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description
      FROM giving_activities ga
      WHERE ga.owner_user_id = ? AND ga.donor_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
        AND ga.category IN ('open_pledge','partially_paid_pledge','completed_gift','pending_gift','pending_pledge')
        AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa WHERE tfa.giving_activity_id = ga.id AND tfa.removed_at IS NULL)
      ORDER BY ga.activity_date DESC`).bind(userId, donorId)
    .all<{ id: string; category: string; workspace_status: string; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null }>();
  return result.results.map((row) => ({ id: row.id, category: row.category, workspaceStatus: row.workspace_status, committedCents: row.committed_cents, paidCents: row.paid_cents, balanceCents: row.balance_cents, activityDate: row.activity_date, description: row.description }));
}

export type AttributeResult = { ok: true; attributionId: string } | { ok: false; reason: "prospect_not_found" | "giving_activity_not_found" | "already_attributed" };

// Attributes an EXISTING giving_activities row to a trip, scoped to one
// trip_prospects row (so the donor must already be a tracked prospect on
// this trip -- the "ownership checks" the task asks for). The giving
// activity must belong to the SAME donor and the SAME owner. The unique
// partial index on trip_financial_attributions (giving_activity_id WHERE
// removed_at IS NULL) is the real double-counting guard -- caught here
// as `already_attributed` rather than a raw constraint error surfacing
// to the caller.
export async function attributeGivingActivityToTrip(userId: string, tripId: string, prospectId: string, givingActivityId: string, note: string | null, now: number): Promise<AttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  const givingActivity = await env.DB.prepare("SELECT id FROM giving_activities WHERE id = ? AND owner_user_id = ? AND donor_id = ?").bind(givingActivityId, userId, prospect.donorId).first<{ id: string }>();
  if (!givingActivity) return { ok: false, reason: "giving_activity_not_found" };
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, tripId, prospect.donorId, givingActivityId, note, now).run();
    return { ok: true, attributionId: id };
  } catch {
    return { ok: false, reason: "already_attributed" };
  }
}

export type TripFinancialAttributionRow = {
  attributionId: string; givingActivityId: string; donorId: string; donorDisplayName: string;
  category: string; workspaceStatus: string; committedCents: number | null; paidCents: number | null; balanceCents: number | null;
  note: string | null; createdAt: number;
};

// Every ACTIVE (removed_at IS NULL) attribution for this trip, with every
// financial field read LIVE from giving_activities at query time -- never
// a snapshot, so a later payment, correction, or category change on the
// underlying record is reflected automatically with zero extra code.
export async function listTripFinancialAttributions(userId: string, tripId: string): Promise<TripFinancialAttributionRow[]> {
  const result = await env.DB.prepare(`SELECT tfa.id AS attribution_id, tfa.giving_activity_id, tfa.donor_id, d.display_name AS donor_display_name,
        ga.category, ga.workspace_status, ga.committed_cents, ga.paid_cents, ga.balance_cents, tfa.note, tfa.created_at
      FROM trip_financial_attributions tfa
      JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
      JOIN donors d ON d.id = tfa.donor_id
      JOIN trips t ON t.id = tfa.trip_id
      WHERE tfa.trip_id = ? AND tfa.removed_at IS NULL AND t.owner_user_id = ?
      ORDER BY tfa.created_at DESC`).bind(tripId, userId)
    .all<{ attribution_id: string; giving_activity_id: string; donor_id: string; donor_display_name: string; category: string; workspace_status: string; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; note: string | null; created_at: number }>();
  return result.results.map((row) => ({
    attributionId: row.attribution_id, givingActivityId: row.giving_activity_id, donorId: row.donor_id, donorDisplayName: row.donor_display_name,
    category: row.category, workspaceStatus: row.workspace_status, committedCents: row.committed_cents, paidCents: row.paid_cents, balanceCents: row.balance_cents,
    note: row.note, createdAt: row.created_at,
  }));
}

// Removes (soft) an attribution -- the task's own "view and correct trip
// attribution without modifying the underlying financial transaction":
// this NEVER touches the giving_activities row, only this link table.
// Scoped by trip ownership, never a bare attributionId lookup.
export async function removeTripFinancialAttribution(userId: string, tripId: string, attributionId: string, reason: string | null, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE trip_financial_attributions SET removed_at = ?, removed_reason = ?
      WHERE id = ? AND trip_id = ? AND removed_at IS NULL
        AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(now, reason, attributionId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0;
}

export type RecordAndAttributeResult =
  | { ok: true; activityId: string; attributionId: string }
  // The gift/pledge WAS recorded (a real giving_activities row exists)
  // but the automatic attribution step failed -- never silently dropped.
  // The caller shows this as "recorded, but use Associate Existing to
  // link it to this trip" rather than a bare failure, since
  // listEligibleGivingActivitiesForDonor will already offer it.
  | { ok: false; reason: "prospect_not_found"; activityId: null }
  | { ok: false; reason: "input_invalid"; error: string; activityId: null }
  | { ok: false; reason: "recorded_but_not_attributed"; activityId: string };

// "Record a new donation/pledge using the existing CRM financial
// workflow" (the task's own wording), from a trip prospect. Validates
// the prospect BEFORE recording anything, so an invalid trip/prospect
// never leaves an orphaned giving_activities row. Delegates the actual
// insert to lib/giving/pending-records.ts's insertPendingGift/
// insertPendingPledge -- the exact same code path the standalone
// app/api/giving/pending[-pledge] endpoints use -- then attributes the
// resulting record to this trip.
export async function recordPendingGiftAndAttribute(userId: string, tripId: string, prospectId: string, rawInput: unknown, now: number): Promise<RecordAndAttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found", activityId: null };
  const inserted = await insertPendingGift(userId, { ...(rawInput as Record<string, unknown>), donorId: prospect.donorId });
  if (!inserted.ok) return { ok: false, reason: "input_invalid", error: inserted.error, activityId: null };
  const attribution = await attributeGivingActivityToTrip(userId, tripId, prospectId, inserted.activityId, null, now);
  if (!attribution.ok) return { ok: false, reason: "recorded_but_not_attributed", activityId: inserted.activityId };
  return { ok: true, activityId: inserted.activityId, attributionId: attribution.attributionId };
}

export async function recordPendingPledgeAndAttribute(userId: string, tripId: string, prospectId: string, rawInput: unknown, now: number): Promise<RecordAndAttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found", activityId: null };
  const inserted = await insertPendingPledge(userId, { ...(rawInput as Record<string, unknown>), donorId: prospect.donorId });
  if (!inserted.ok) return { ok: false, reason: "input_invalid", error: inserted.error, activityId: null };
  const attribution = await attributeGivingActivityToTrip(userId, tripId, prospectId, inserted.activityId, null, now);
  if (!attribution.ok) return { ok: false, reason: "recorded_but_not_attributed", activityId: inserted.activityId };
  return { ok: true, activityId: inserted.activityId, attributionId: attribution.attributionId };
}

export { statusRequiresInteraction, timezoneForState };
