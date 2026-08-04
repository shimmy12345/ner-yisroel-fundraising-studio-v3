ALTER TABLE `giving_activities` ADD COLUMN `workspace_status` text NOT NULL DEFAULT 'active' CHECK (`workspace_status` IN ('active','hidden','duplicate','needs_review','invalid','merged'));
ALTER TABLE `giving_activities` ADD COLUMN `private_note` text;
ALTER TABLE `giving_activities` ADD COLUMN `confirmed_by_activity_id` text;

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

CREATE INDEX `idx_giving_activities_owner_workspace_status_date` ON `giving_activities` (`owner_user_id`,`workspace_status`,`activity_date`);
CREATE INDEX `idx_giving_activities_pending_match` ON `giving_activities` (`owner_user_id`,`donor_id`,`category`,`workspace_status`,`committed_cents`,`activity_date`);
CREATE INDEX `idx_giving_management_audit_activity_date` ON `giving_activity_management_audits` (`activity_id`,`created_at`);
CREATE INDEX `idx_giving_management_audit_import` ON `giving_activity_management_audits` (`import_id`,`created_at`);

PRAGMA optimize;
