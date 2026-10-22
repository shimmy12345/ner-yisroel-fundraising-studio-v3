-- AI Meeting Notes save-identity/payload comparison fix (2026-10-22,
-- fifth follow-up review). STAGING ONLY -- not applied to Production as
-- part of this round, same carve-out as drizzle/0046, 0047, 0050, 0051,
-- and 0052.
--
-- Closes two confirmed retry defects in saveConcurrentSummaryAndFollowUps
-- against the `9341910` candidate:
--
-- 1. An identical retry (same save identity, same follow-up payload,
-- after the primary CAS trivially re-matches because the summary text
-- never changed) used to DELETE and re-INSERT each follow-up's
-- `recommendations` row to make the "already applied, create nothing
-- new" case idempotent. A DELETE+INSERT is not a no-op: if the follow-up
-- had since been completed (or otherwise changed) through some OTHER
-- path, the retry silently reopened it and reset `created_at`. Every
-- follow-up write is now a plain `INSERT ... ON CONFLICT(id) DO NOTHING`
-- -- a genuine no-op when the row already exists, touching nothing at
-- all (not even a rewritten identical value) -- and `followUpsCreated`
-- in the response now reflects the actual per-statement INSERT rowcount,
-- never a blind `followUps.length`.
--
-- 2. `followUpsAlreadyMatch` only ever queried the ids the RETRYING
-- request itself submitted, so a retry that silently dropped, added,
-- reordered, or recolored one of the original save's follow-ups while
-- keeping the others unchanged was reported as a safe "replayed" no-op
-- -- the dropped follow-up's own existing row was simply never looked
-- at. Detecting that requires knowing the COMPLETE original payload for
-- this save identity, which the retrying request's own body cannot
-- prove on its own (it is exactly the thing in question).
--
-- `meeting_note_save_identities` is the reliable, explicit record of
-- that complete original payload, keyed by the client's own
-- `idempotencyKey` (`save_id`, globally unique by construction -- it is
-- already the same value every meeting-note follow-up id is namespaced
-- under). The CAS'd primary write and the follow-up writes commit in one
-- transaction with this row (see lib/meeting-notes/concurrent-save.ts):
-- an `INSERT ... ON CONFLICT(save_id) DO UPDATE` whose UPDATE branch
-- sets `payload_signature` to ITSELF when the newly computed signature
-- (a deterministic JSON serialization of every submitted follow-up's
-- id/description/due date, in submitted order) matches what is already
-- on record -- a true no-op -- or to NULL when it does not. Because
-- `payload_signature` is NOT NULL, a mismatch is a genuine constraint
-- violation, which rolls the ENTIRE batch back, including the primary
-- summary UPDATE -- never a partial apply, and never a second ledger
-- table that itself needs its own separate atomicity story. A follow-up
-- added, removed, reordered, or recolored under the same save identity
-- changes the signature and is therefore rejected in full, exactly like
-- any other payload mismatch this round's own write_token mechanism
-- already rejects in full.
--
-- Nothing is ever deleted from this table; it grows at most one row per
-- distinct client-generated idempotencyKey, mirroring how `interactions`
-- and `recommendations` rows themselves already accumulate without
-- pruning. `interaction_id` is informational (which meeting this save
-- identity belongs to) and indexed for any future lookup/cleanup need,
-- never read by the comparison logic itself (`save_id` alone is the key).
CREATE TABLE `meeting_note_save_identities` (
  `save_id` text PRIMARY KEY NOT NULL,
  `interaction_id` text NOT NULL,
  `payload_signature` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meeting_note_save_identities_interaction_idx` ON `meeting_note_save_identities` (`interaction_id`);
