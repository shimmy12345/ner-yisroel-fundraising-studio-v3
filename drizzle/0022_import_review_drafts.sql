-- The donation import preview session now doubles as a durable review
-- draft: decisions accumulate here as the user reviews rows, and the row's
-- inactivity TTL is extended on every touch instead of expiring on a fixed
-- schedule from creation. See lib/import/preview-session.ts.
ALTER TABLE `import_preview_sessions` ADD COLUMN `decisions_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `import_preview_sessions` ADD COLUMN `status` text NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `import_preview_sessions` ADD COLUMN `updated_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `import_preview_sessions` ADD COLUMN `progress_resolved` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `import_preview_sessions` ADD COLUMN `progress_total` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `import_preview_sessions` SET `updated_at` = `created_at` WHERE `updated_at` = 0;
--> statement-breakpoint
CREATE INDEX `import_preview_sessions_owner_status_idx` ON `import_preview_sessions` (`owner_user_id`,`status`,`expires_at`);
