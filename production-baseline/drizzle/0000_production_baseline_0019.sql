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

CREATE TABLE `interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `summary` text NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
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
  `updated_at` integer NOT NULL,
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

CREATE INDEX `activity_status_audits_interaction_date_idx` ON `activity_status_audits` (`interaction_id`,`created_at`);

CREATE INDEX `data_imports_user_date_idx` ON `data_imports` (`user_id`,`created_at`);

CREATE INDEX `data_imports_user_file_hash_status_idx` ON `data_imports` (`user_id`,`file_hash`,`status`);

CREATE UNIQUE INDEX `donation_import_rollback_audits_import_idx` ON `donation_import_rollback_audits` (`import_id`);

CREATE INDEX `donation_import_rollback_audits_user_date_idx` ON `donation_import_rollback_audits` (`user_id`,`created_at`);

CREATE INDEX `donor_contact_audits_donor_date_idx` ON `donor_contact_audits` (`donor_id`,`created_at`);

CREATE INDEX `donor_merge_audits_archived_idx`
ON `donor_merge_audits` (`archived_donor_id`);

CREATE INDEX `donor_merge_audits_user_date_idx`
ON `donor_merge_audits` (`user_id`,`created_at`);

CREATE INDEX `donor_views_user_date_idx` ON `donor_views` (`user_id`,`viewed_at`);

CREATE INDEX `donors_merged_into_idx`
ON `donors` (`merged_into_donor_id`);

CREATE INDEX `donors_owner_active_idx`
ON `donors` (`owner_user_id`,`data_source`,`archived_at`);

CREATE UNIQUE INDEX `donors_owner_donor_code_unique` ON `donors` (`owner_user_id`,`donor_code`);

CREATE UNIQUE INDEX `donors_owner_external_source_id_unique` ON `donors` (`owner_user_id`,`external_source`,`external_id`);

CREATE INDEX `donors_owner_mode_name_idx` ON `donors` (`owner_user_id`,`data_source`,`display_name`);

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

CREATE INDEX `interactions_donor_date_idx` ON `interactions` (`donor_id`,`occurred_at`);

CREATE UNIQUE INDEX `jl_payment_assignment_audits_import_payment_idx` ON `jl_payment_assignment_audits` (`import_id`,`payment_fingerprint`);

CREATE INDEX `jl_payment_assignment_audits_pledge_idx` ON `jl_payment_assignment_audits` (`pledge_activity_id`,`created_at`);

CREATE INDEX `jl_payment_assignment_audits_user_date_idx` ON `jl_payment_assignment_audits` (`user_id`,`created_at`);

CREATE INDEX `jl_payment_assignments_pledge_idx` ON `jl_payment_assignments` (`pledge_activity_id`);

CREATE INDEX `recommendations_user_status_idx` ON `recommendations` (`user_id`,`status`);

CREATE INDEX `relationship_queue_dismissals_user_date_idx` ON `relationship_queue_dismissals` (`user_id`,`dismissed_at`);

CREATE INDEX `sample_cleanup_audits_user_date_idx` ON `sample_cleanup_audits` (`user_id`,`created_at`);

CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);

CREATE INDEX `workspace_backup_audits_user_import_idx` ON `workspace_backup_audits` (`user_id`,`import_id`,`created_at`);

CREATE TABLE `production_schema_baseline` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = '0019'),
  `schema_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
INSERT INTO `production_schema_baseline` (`id`,`schema_hash`,`created_at`) VALUES ('0019','0df7c3561261e9e500d8f7fe563ea76ae19fcb0304a994ff5354b210e0f4e41b',1785944072);
PRAGMA optimize;
