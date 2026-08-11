-- Donor Research (Stage A). Provider-agnostic evidence model: no
-- donor_research_promotions (no canonical donor write-back path exists in
-- Stage A), no donor_research_monitors (no scheduled monitoring in Stage
-- A). Evidence lives in donor_research_pending_evidence, scoped to a
-- single open run, until the run's identity candidate is explicitly
-- confirmed -- it is never written into the shared, workspace-scoped
-- donor_research_sources pool before that. See lib/research/*.
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
--> statement-breakpoint
CREATE INDEX `donor_research_runs_donor_date_idx` ON `donor_research_runs` (`donor_id`,`created_at`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `donor_research_pending_evidence_run_idx` ON `donor_research_pending_evidence` (`run_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `donor_research_identity_candidates_donor_status_idx` ON `donor_research_identity_candidates` (`donor_id`,`status`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `donor_research_findings_donor_status_category_idx` ON `donor_research_findings` (`donor_id`,`status`,`category`);
--> statement-breakpoint
CREATE UNIQUE INDEX `donor_research_findings_donor_fingerprint_active_uidx` ON `donor_research_findings` (`donor_id`,`fingerprint`) WHERE `status` IN ('current','unverified');
--> statement-breakpoint
CREATE INDEX `donor_research_findings_user_org_idx` ON `donor_research_findings` (`user_id`,`organization_normalized`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `donor_research_sources_user_normalized_url_uidx` ON `donor_research_sources` (`user_id`,`normalized_url`);
--> statement-breakpoint
CREATE INDEX `donor_research_sources_user_domain_idx` ON `donor_research_sources` (`user_id`,`domain`);
--> statement-breakpoint
CREATE TABLE `donor_research_finding_sources` (
  `finding_id` text NOT NULL,
  `source_id` text NOT NULL,
  PRIMARY KEY (`finding_id`,`source_id`),
  FOREIGN KEY (`finding_id`) REFERENCES `donor_research_findings`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_id`) REFERENCES `donor_research_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `donor_research_finding_sources_source_idx` ON `donor_research_finding_sources` (`source_id`);
