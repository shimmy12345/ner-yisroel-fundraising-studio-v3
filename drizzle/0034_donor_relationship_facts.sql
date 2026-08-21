-- Relationship Intelligence Phase 1 (see docs/AI-HANDOFF.md's
-- "Relationship Snapshot Synthesis Design" sections) -- durable accepted
-- relationship facts, one row per accepted fact, never overwritten in
-- place. donors.relationship_summary/institutional_memory become a
-- SYNTHESIZED, regenerated view derived from this table starting Phase 2;
-- this table is the actual durable store. Modeled directly on
-- donor_research_findings' proven status/supersession shape
-- (status/supersedes_finding_id), not a novel pattern -- including that
-- precedent's own choice not to declare supersedes_fact_id a real FK (a
-- fact is never hard-deleted, so there is no dangling-reference risk a
-- self-referencing FK would guard against).
--
-- category = WHAT the fact is about (supersession-matching only, never
-- decay). lifecycle = HOW LONG it stays relevant, deliberately
-- independent of category -- the Lifecycle Correction's whole point:
-- "his daughter is Danielle" and "his daughter is getting married in
-- November" share a category but must not share a lifecycle. durable =
-- never decays. time_bound = decays per category's window. follow_up =
-- never enters Snapshot synthesis at all.
--
-- source_interaction_id is null only for Phase 1 backfilled facts (no
-- single real interaction can be proven as the source for today's
-- pre-existing donors.relationship_summary text). source_interaction_
-- occurred_at is the decay-clock start -- for a backfilled fact this is
-- CLAMPED to the backfill's own run time, never a real historical date,
-- so a backfilled time_bound fact gets a full fresh decay grace period.
--
-- fingerprint deliberately INCLUDES source_interaction_id (unlike
-- donor_research_findings' own fingerprint, which excludes source): two
-- different interactions that happen to produce coincidentally-identical
-- fact text are two separate accepted moments here, not one corroborated
-- fact.
CREATE TABLE `donor_relationship_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`donor_id` text NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`lifecycle` text NOT NULL,
	`fact_text` text NOT NULL,
	`source_interaction_id` text,
	`source_interaction_occurred_at` integer NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`supersedes_fact_id` text,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action,
	CHECK (`category` IN ('family_milestone','solicitation','health','commitment_followup','engagement','general')),
	CHECK (`lifecycle` IN ('durable','time_bound','follow_up')),
	CHECK (`status` IN ('current','superseded','archived_with_source'))
);
--> statement-breakpoint
CREATE INDEX `donor_relationship_facts_donor_status_idx` ON `donor_relationship_facts` (`donor_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `donor_relationship_facts_user_fingerprint_uidx` ON `donor_relationship_facts` (`user_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `donor_relationship_facts_supersedes_idx` ON `donor_relationship_facts` (`supersedes_fact_id`);
--> statement-breakpoint
-- Append-only audit trail for donor_relationship_facts, matching
-- ask_changes/pledge_payment_plan_changes' shape exactly. fact_id IS a
-- real foreign key -- facts are never hard-deleted, only status-
-- transitioned, so an audit row can never outlive the fact it describes.
CREATE TABLE `donor_relationship_fact_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`donor_id` text NOT NULL,
	`action` text NOT NULL,
	`changed_fields` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fact_id`) REFERENCES `donor_relationship_facts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	CHECK (`action` IN ('created','superseded','archived_with_source','restored'))
);
--> statement-breakpoint
CREATE INDEX `donor_relationship_fact_changes_fact_idx` ON `donor_relationship_fact_changes` (`fact_id`,`created_at`);
