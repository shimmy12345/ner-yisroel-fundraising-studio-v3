-- Fundraising OS production schema baseline through 0019.
-- Apply only to a brand-new empty D1 database. Never apply to staging.
PRAGMA foreign_keys=ON;

CREATE TABLE `activity_status_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `interaction_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,
  `from_status` text NOT NULL,
  `to_status` text NOT NULL,
  `previous_source` text NOT NULL,
  `next_source` text NOT NULL,
  `previous_occurred_at` integer NOT NULL,
  `next_occurred_at` integer NOT NULL,
  `previous_summary` text NOT NULL,
  `next_summary` text NOT NULL,
  `follow_up_id` text,
  `created_at` integer NOT NULL,
  `undone_at` integer,
  FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `ask_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `ask_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','status_changed')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`ask_id`) REFERENCES `asks`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `asks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `amount_cents` integer,
  `purpose` text,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','committed','declined','withdrawn')),
  `asked_at` integer NOT NULL,
  `note` text,
  `source_interaction_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `data_health_repair_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `record_type` text NOT NULL CHECK (`record_type` IN ('interaction','reminder')),
  `record_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('reattach','move_to_survivor','archive','dismiss_false_positive')),
  `previous_donor_id` text,
  `next_donor_id` text,
  `previous_state_json` text NOT NULL,
  `next_state_json` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `data_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `file_name` text NOT NULL,
  `file_hash` text NOT NULL,
  `status` text NOT NULL,
  `update_existing` integer DEFAULT 0 NOT NULL,
  `report_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donation_import_rollback_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `preview_json` text NOT NULL,
  `removed_gifts` integer NOT NULL,
  `restored_pledges` integer NOT NULL,
  `restored_balances` integer NOT NULL,
  `restored_statuses` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_contact_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL,
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_historical_context` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `text` text NOT NULL,
  `source_date` integer,
  `classification` text NOT NULL,
  `source` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text NOT NULL DEFAULT 'unconfirmed' CHECK (`status` IN ('unconfirmed','dismissed')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_merge_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `surviving_donor_id` text NOT NULL,
  `archived_donor_id` text NOT NULL,
  `field_choices_json` text NOT NULL,
  `survivor_before_json` text NOT NULL,
  `duplicate_before_json` text NOT NULL,
  `survivor_after_json` text NOT NULL,
  `moved_counts_json` text NOT NULL,
  `source` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`surviving_donor_id`) REFERENCES `donors`(`id`),
  FOREIGN KEY (`archived_donor_id`) REFERENCES `donors`(`id`)
);

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

CREATE TABLE `donor_research_finding_sources` (
  `finding_id` text NOT NULL,
  `source_id` text NOT NULL,
  PRIMARY KEY (`finding_id`,`source_id`),
  FOREIGN KEY (`finding_id`) REFERENCES `donor_research_findings`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_id`) REFERENCES `donor_research_sources`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_research_findings` (
  `id` text PRIMARY KEY NOT NULL,
  `first_seen_run_id` text NOT NULL,
  `last_confirmed_run_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `category` text NOT NULL CHECK (`category` IN ('professional','boards_affiliations','public_philanthropy','recent_mentions','possible_connections','notes_ambiguities')),
  `claim` text NOT NULL,
  `related_donor_id` text,
  `organization_normalized` text,
  `status` text NOT NULL DEFAULT 'current' CHECK (`status` IN ('current','superseded','removed_not_found','unverified')),
  `fingerprint` text NOT NULL,
  `supersedes_finding_id` text,
  `not_found_streak` integer NOT NULL DEFAULT 0,
  `notified_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`first_seen_run_id`) REFERENCES `donor_research_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`last_confirmed_run_id`) REFERENCES `donor_research_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`related_donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`supersedes_finding_id`) REFERENCES `donor_research_findings`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_research_identity_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `label` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','confirmed','rejected')),
  `decided_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `donor_research_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_research_pending_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `url` text NOT NULL,
  `title` text NOT NULL,
  `snippet` text,
  `published_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `donor_research_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_research_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open','completed','discarded')),
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_research_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `url` text NOT NULL,
  `normalized_url` text NOT NULL,
  `domain` text NOT NULL,
  `title` text NOT NULL,
  `publisher` text,
  `published_at` integer,
  `retrieved_at` integer NOT NULL,
  `excerpt` text,
  `source_tier` text NOT NULL CHECK (`source_tier` IN ('primary_institutional','press_release','reputable_news','event_program','public_search_result')),
  `discovered_via` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donor_views` (
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `viewed_at` integer NOT NULL,
  PRIMARY KEY (`user_id`,`donor_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `donors` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `email` text,
  `phone` text,
  `location` text,
  `relationship_summary` text,
  `institutional_memory` text,
  `relationship_health` integer,
  `preferred_communication` text,
  `interests` text,
  `family` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
, `donor_code` text, `spouse` text, `address` text, `external_source` text, `external_id` text, `last_name` text, `primary_first_name` text, `spouse_first_name` text, `primary_title` text, `spouse_title` text, `alternate_mobile_phone` text, `home_phone` text, `address_line_1` text, `city` text, `state` text, `postal_code` text, `country` text, `source_snapshot` text, `owner_user_id` text REFERENCES `users`(`id`), `data_source` text DEFAULT 'live' NOT NULL, `contact_note` text, `archived_at` integer, `merged_into_donor_id` text REFERENCES `donors`(`id`));

CREATE TABLE `gift_acknowledgments` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `gift_source` text NOT NULL CHECK (`gift_source` IN ('giving_activity','gift')),
  `gift_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('thank_you_sent','thank_you_call','no_acknowledgment_needed')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `gifts` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `fund` text NOT NULL,
  `received_at` integer NOT NULL,
  `acknowledged_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `note` text,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `giving_activities` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `external_source` text NOT NULL,
  `external_household_id` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `activity_date` integer,
  `committed_cents` integer,
  `paid_cents` integer,
  `balance_cents` integer,
  `item_type` text,
  `description` text,
  `source_campaign` text,
  `category` text NOT NULL,
  `source_snapshot` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `owner_user_id` text REFERENCES `users`(`id`), `record_origin` text DEFAULT 'live' NOT NULL, `workspace_status` text NOT NULL DEFAULT 'active' CHECK (`workspace_status` IN ('active','hidden','duplicate','needs_review','invalid','merged')), `private_note` text, `confirmed_by_activity_id` text,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `giving_activity_import_changes` (
  `import_id` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `change_type` text NOT NULL,
  `previous_json` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`import_id`,`source_fingerprint`),
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `giving_activity_management_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `activity_id` text NOT NULL,
  `import_id` text,
  `action` text NOT NULL,
  `previous_donor_id` text,
  `next_donor_id` text,
  `previous_status` text,
  `next_status` text,
  `previous_note` text,
  `next_note` text,
  `created_at` integer NOT NULL,
  `undone_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `household_import_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `import_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `change_type` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `household_import_rollback_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `preview_json` text NOT NULL,
  `removed_donors` integer NOT NULL,
  `restored_donors` integer NOT NULL,
  `preserved_later_edits` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `import_preview_session_chunks` (
  `session_id` text NOT NULL,
  `chunk_index` integer NOT NULL,
  `rows_json` text NOT NULL,
  PRIMARY KEY (`session_id`,`chunk_index`),
  FOREIGN KEY (`session_id`) REFERENCES `import_preview_sessions`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `import_preview_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `file_hash` text NOT NULL,
  `file_name` text NOT NULL,
  `mapping_json` text NOT NULL,
  `force_type` text,
  `row_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL, `decisions_json` text NOT NULL DEFAULT '{}', `status` text NOT NULL DEFAULT 'draft', `updated_at` integer NOT NULL DEFAULT 0, `progress_resolved` integer NOT NULL DEFAULT 0, `progress_total` integer NOT NULL DEFAULT 0,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `important_date_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `important_date_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','deleted')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE "important_dates" (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('birthday','anniversary')),
  `person_name` text,
  `relationship` text,
  `month` integer NOT NULL,
  `day` integer NOT NULL,
  `year` integer,
  `notes` text,
  `source` text NOT NULL CHECK (`source` IN ('manual','import-dob')),
  `fingerprint` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `summary` text NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `occurred_at_date_only` integer DEFAULT 0 NOT NULL, `shared_activity_id` text REFERENCES `shared_activities`(`id`), `role` text CHECK (`role` IN ('participant','recipient')),
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `jl_payment_assignment_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `payment_fingerprint` text NOT NULL,
  `donor_id` text NOT NULL,
  `pledge_activity_id` text,
  `decision_type` text NOT NULL CHECK (`decision_type` IN ('apply_to_pledge', 'new_gift')),
  `payment_cents` integer NOT NULL,
  `applied_cents` integer NOT NULL,
  `new_gift_cents` integer NOT NULL,
  `overpayment_action` text CHECK (`overpayment_action` IS NULL OR `overpayment_action` = 'split_remainder_new_gift'),
  `previous_paid_cents` integer,
  `next_paid_cents` integer,
  `previous_balance_cents` integer,
  `next_balance_cents` integer,
  `previous_status` text,
  `next_status` text,
  `created_at` integer NOT NULL, `payment_date` integer, `remaining_balance_cents` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `jl_payment_assignments` (
  `user_id` text NOT NULL,
  `payment_fingerprint` text NOT NULL,
  `decision_type` text NOT NULL CHECK (`decision_type` IN ('apply_to_pledge', 'new_gift')),
  `pledge_activity_id` text,
  `applied_import_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `payment_fingerprint`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `jl_refresh_state` (
  `user_id` text PRIMARY KEY NOT NULL,
  `last_household_refresh_at` integer,
  `last_donation_refresh_at` integer,
  `last_donation_range_start` integer,
  `last_donation_range_end` integer,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `legacy_test_cleanup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `preview_hash` text NOT NULL,
  `records_json` text NOT NULL,
  `archived_interactions` integer NOT NULL,
  `archived_reminders` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `onboarding_preferences` (
  `user_id` text PRIMARY KEY NOT NULL,
  `sample_data_acknowledged` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL, `data_mode` text DEFAULT 'live' NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `pledge_payment_plan_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `plan_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','ended')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`plan_id`) REFERENCES `pledge_payment_plans`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `pledge_payment_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `pledge_activity_id` text NOT NULL,
  `cadence` text NOT NULL DEFAULT 'monthly' CHECK (`cadence` IN ('monthly')),
  `installment_amount_cents` integer,
  `expected_day_of_month` integer NOT NULL,
  `next_expected_payment_at` integer NOT NULL,
  `final_expected_payment_at` integer NOT NULL,
  `note` text,
  `ended_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action,
  CHECK (`expected_day_of_month` BETWEEN 1 AND 31)
);

CREATE TABLE `recommendations` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,
  `reason` text NOT NULL,
  `score` integer NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `due_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL, `due_at_date_only` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `relationship_queue_dismissals` (
  `user_id` text NOT NULL,
  `item_key` text NOT NULL,
  `donor_id` text NOT NULL,
  `dismissed_at` integer NOT NULL,
  PRIMARY KEY (`user_id`,`item_key`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `sample_cleanup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `removed_donors` integer NOT NULL,
  `removed_gifts` integer NOT NULL,
  `removed_interactions` integer NOT NULL,
  `removed_recommendations` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE "shared_activities" (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('call','email','meeting','visit','note','personal','gift','text')),
  `occurred_at` integer NOT NULL,
  `occurred_at_date_only` integer NOT NULL DEFAULT 0,
  `summary` text NOT NULL,
  `source` text NOT NULL DEFAULT 'manual',
  `recipient_count` integer NOT NULL DEFAULT 0,
  `deleted_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `shared_activity_recipient_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `shared_activity_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('added','removed')),
  `created_at` integer NOT NULL,
  FOREIGN KEY (`shared_activity_id`) REFERENCES `shared_activities`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `name` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
, `preferred_first_name` text, `organization_name` text, `job_title` text, `timezone` text DEFAULT 'America/New_York' NOT NULL, `avatar_url` text, `household_import_review_mode` text NOT NULL DEFAULT 'auto_unchanged');

CREATE TABLE `workspace_backup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `purpose` text NOT NULL,
  `import_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `yahrtzeit_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `yahrtzeit_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','deleted')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `yahrtzeits` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `deceased_name_english` text NOT NULL,
  `deceased_name_hebrew` text,
  `relationship` text NOT NULL,
  `hebrew_month` text NOT NULL,
  `hebrew_day` integer NOT NULL,
  `hebrew_year` integer,
  `source` text NOT NULL CHECK (`source` IN ('manual','import-yahrtzeit-workbook')),
  `source_donor_code` text,
  `fingerprint` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `activity_status_audits_interaction_date_idx` ON `activity_status_audits` (`interaction_id`,`created_at`);

CREATE INDEX `ask_changes_ask_idx` ON `ask_changes` (`ask_id`,`created_at`);

CREATE INDEX `asks_donor_status_idx` ON `asks` (`donor_id`,`status`);

CREATE INDEX `data_imports_user_date_idx` ON `data_imports` (`user_id`,`created_at`);

CREATE INDEX `data_imports_user_file_hash_status_idx` ON `data_imports` (`user_id`,`file_hash`,`status`);

CREATE UNIQUE INDEX `donation_import_rollback_audits_import_idx` ON `donation_import_rollback_audits` (`import_id`);

CREATE INDEX `donation_import_rollback_audits_user_date_idx` ON `donation_import_rollback_audits` (`user_id`,`created_at`);

CREATE INDEX `donor_contact_audits_donor_date_idx` ON `donor_contact_audits` (`donor_id`,`created_at`);

CREATE INDEX `donor_historical_context_donor_date_idx` ON `donor_historical_context` (`donor_id`,`created_at`);

CREATE UNIQUE INDEX `donor_historical_context_user_fingerprint_uidx` ON `donor_historical_context` (`user_id`,`fingerprint`);

CREATE INDEX `donor_merge_audits_archived_idx`
ON `donor_merge_audits` (`archived_donor_id`);

CREATE INDEX `donor_merge_audits_user_date_idx`
ON `donor_merge_audits` (`user_id`,`created_at`);

CREATE INDEX `donor_relationship_fact_changes_fact_idx` ON `donor_relationship_fact_changes` (`fact_id`,`created_at`);

CREATE INDEX `donor_relationship_facts_donor_status_idx` ON `donor_relationship_facts` (`donor_id`,`status`);

CREATE INDEX `donor_relationship_facts_supersedes_idx` ON `donor_relationship_facts` (`supersedes_fact_id`);

CREATE UNIQUE INDEX `donor_relationship_facts_user_fingerprint_uidx` ON `donor_relationship_facts` (`user_id`,`fingerprint`);

CREATE INDEX `donor_research_finding_sources_source_idx` ON `donor_research_finding_sources` (`source_id`);

CREATE UNIQUE INDEX `donor_research_findings_donor_fingerprint_active_uidx` ON `donor_research_findings` (`donor_id`,`fingerprint`) WHERE `status` IN ('current','unverified');

CREATE INDEX `donor_research_findings_donor_status_category_idx` ON `donor_research_findings` (`donor_id`,`status`,`category`);

CREATE INDEX `donor_research_findings_user_org_idx` ON `donor_research_findings` (`user_id`,`organization_normalized`);

CREATE INDEX `donor_research_identity_candidates_donor_status_idx` ON `donor_research_identity_candidates` (`donor_id`,`status`);

CREATE INDEX `donor_research_pending_evidence_run_idx` ON `donor_research_pending_evidence` (`run_id`);

CREATE INDEX `donor_research_runs_donor_date_idx` ON `donor_research_runs` (`donor_id`,`created_at`);

CREATE INDEX `donor_research_sources_user_domain_idx` ON `donor_research_sources` (`user_id`,`domain`);

CREATE UNIQUE INDEX `donor_research_sources_user_normalized_url_uidx` ON `donor_research_sources` (`user_id`,`normalized_url`);

CREATE INDEX `donor_views_user_date_idx` ON `donor_views` (`user_id`,`viewed_at`);

CREATE INDEX `donors_merged_into_idx`
ON `donors` (`merged_into_donor_id`);

CREATE INDEX `donors_owner_active_idx`
ON `donors` (`owner_user_id`,`data_source`,`archived_at`);

CREATE UNIQUE INDEX `donors_owner_donor_code_unique` ON `donors` (`owner_user_id`,`donor_code`);

CREATE UNIQUE INDEX `donors_owner_external_source_id_unique` ON `donors` (`owner_user_id`,`external_source`,`external_id`);

CREATE INDEX `donors_owner_mode_name_idx` ON `donors` (`owner_user_id`,`data_source`,`display_name`);

CREATE INDEX `gift_acknowledgments_donor_idx` ON `gift_acknowledgments` (`donor_id`,`created_at`);

CREATE INDEX `gift_acknowledgments_gift_idx` ON `gift_acknowledgments` (`user_id`,`gift_source`,`gift_id`,`created_at`);

CREATE INDEX `gifts_donor_date_idx` ON `gifts` (`donor_id`,`received_at`);

CREATE INDEX `giving_activities_donor_date_idx` ON `giving_activities` (`donor_id`,`activity_date`);

CREATE INDEX `giving_activities_owner_date_idx` ON `giving_activities` (`owner_user_id`,`activity_date`);

CREATE INDEX `giving_activities_owner_origin_date_idx` ON `giving_activities` (`owner_user_id`,`record_origin`,`activity_date`);

CREATE UNIQUE INDEX `giving_activities_owner_source_fingerprint_unique` ON `giving_activities` (`owner_user_id`,`external_source`,`source_fingerprint`);

CREATE UNIQUE INDEX `household_import_changes_batch_donor_idx` ON `household_import_changes` (`import_id`,`donor_id`);

CREATE INDEX `household_import_changes_user_date_idx` ON `household_import_changes` (`user_id`,`created_at`);

CREATE UNIQUE INDEX `household_import_rollback_audits_import_idx` ON `household_import_rollback_audits` (`import_id`);

CREATE INDEX `household_import_rollback_audits_user_date_idx` ON `household_import_rollback_audits` (`user_id`,`created_at`);

CREATE INDEX `idx_data_health_repairs_user_date`
ON `data_health_repair_audits` (`user_id`,`created_at`);

CREATE INDEX `idx_data_health_repairs_user_record`
ON `data_health_repair_audits` (`user_id`,`record_type`,`record_id`,`created_at`);

CREATE INDEX `idx_giving_activities_owner_workspace_status_date` ON `giving_activities` (`owner_user_id`,`workspace_status`,`activity_date`);

CREATE INDEX `idx_giving_activities_pending_match` ON `giving_activities` (`owner_user_id`,`donor_id`,`category`,`workspace_status`,`committed_cents`,`activity_date`);

CREATE INDEX `idx_giving_management_audit_activity_date` ON `giving_activity_management_audits` (`activity_id`,`created_at`);

CREATE INDEX `idx_giving_management_audit_import` ON `giving_activity_management_audits` (`import_id`,`created_at`);

CREATE INDEX `idx_legacy_test_cleanup_user_date`
ON `legacy_test_cleanup_audits` (`user_id`,`created_at`);

CREATE INDEX `import_preview_sessions_owner_expires_idx` ON `import_preview_sessions` (`owner_user_id`,`expires_at`);

CREATE INDEX `import_preview_sessions_owner_status_idx` ON `import_preview_sessions` (`owner_user_id`,`status`,`expires_at`);

CREATE INDEX `important_date_changes_important_date_idx` ON `important_date_changes` (`important_date_id`,`created_at`);

CREATE INDEX `important_dates_donor_idx` ON `important_dates` (`donor_id`,`type`,`month`,`day`);

CREATE UNIQUE INDEX `important_dates_fingerprint_idx` ON `important_dates` (`fingerprint`);

CREATE INDEX `important_dates_user_idx` ON `important_dates` (`user_id`);

CREATE INDEX `interactions_donor_date_idx` ON `interactions` (`donor_id`,`occurred_at`);

CREATE UNIQUE INDEX `interactions_shared_activity_donor_uidx` ON `interactions` (`shared_activity_id`,`donor_id`) WHERE `shared_activity_id` IS NOT NULL;

CREATE INDEX `interactions_shared_activity_idx` ON `interactions` (`shared_activity_id`);

CREATE UNIQUE INDEX `jl_payment_assignment_audits_import_payment_idx` ON `jl_payment_assignment_audits` (`import_id`,`payment_fingerprint`);

CREATE INDEX `jl_payment_assignment_audits_pledge_idx` ON `jl_payment_assignment_audits` (`pledge_activity_id`,`created_at`);

CREATE INDEX `jl_payment_assignment_audits_user_date_idx` ON `jl_payment_assignment_audits` (`user_id`,`created_at`);

CREATE INDEX `jl_payment_assignments_pledge_idx` ON `jl_payment_assignments` (`pledge_activity_id`);

CREATE INDEX `pledge_payment_plan_changes_plan_idx` ON `pledge_payment_plan_changes` (`plan_id`,`created_at`);

CREATE INDEX `pledge_payment_plans_pledge_idx` ON `pledge_payment_plans` (`pledge_activity_id`);

CREATE INDEX `recommendations_user_status_idx` ON `recommendations` (`user_id`,`status`);

CREATE INDEX `relationship_queue_dismissals_user_date_idx` ON `relationship_queue_dismissals` (`user_id`,`dismissed_at`);

CREATE INDEX `sample_cleanup_audits_user_date_idx` ON `sample_cleanup_audits` (`user_id`,`created_at`);

CREATE INDEX `shared_activities_user_date_idx` ON `shared_activities` (`user_id`,`occurred_at`);

CREATE INDEX `shared_activity_recipient_audits_activity_date_idx` ON `shared_activity_recipient_audits` (`shared_activity_id`,`created_at`);

CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);

CREATE INDEX `workspace_backup_audits_user_import_idx` ON `workspace_backup_audits` (`user_id`,`import_id`,`created_at`);

CREATE INDEX `yahrtzeit_changes_yahrtzeit_idx` ON `yahrtzeit_changes` (`yahrtzeit_id`,`created_at`);

CREATE INDEX `yahrtzeits_donor_idx` ON `yahrtzeits` (`donor_id`,`hebrew_month`,`hebrew_day`);

CREATE UNIQUE INDEX `yahrtzeits_fingerprint_idx` ON `yahrtzeits` (`fingerprint`);

CREATE INDEX `yahrtzeits_user_idx` ON `yahrtzeits` (`user_id`);

CREATE TABLE `production_schema_baseline` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = '0019'),
  `schema_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
INSERT INTO `production_schema_baseline` (`id`,`schema_hash`,`created_at`) VALUES ('0019','438970f3383cc52ae27dea859a1235a50ea03dc31a7adb82c2aa147212db5ec9',1785944072);
PRAGMA optimize;
