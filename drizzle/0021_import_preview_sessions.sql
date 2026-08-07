-- Server-side, short-lived storage for a reviewed donation import's parsed
-- rows, so the final commit request can send an id instead of re-uploading
-- the entire file. Owner-scoped and expiring; never shared across users.
CREATE TABLE `import_preview_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `file_hash` text NOT NULL,
  `file_name` text NOT NULL,
  `mapping_json` text NOT NULL,
  `force_type` text,
  `row_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_preview_sessions_owner_expires_idx` ON `import_preview_sessions` (`owner_user_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `import_preview_session_chunks` (
  `session_id` text NOT NULL,
  `chunk_index` integer NOT NULL,
  `rows_json` text NOT NULL,
  PRIMARY KEY (`session_id`,`chunk_index`),
  FOREIGN KEY (`session_id`) REFERENCES `import_preview_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
