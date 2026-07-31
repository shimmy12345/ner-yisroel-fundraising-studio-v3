-- Idempotent sample data for the isolated Fundraising OS staging database.
-- All people, contact details, gifts, and interactions below are fictional.
INSERT OR IGNORE INTO `users` (`id`, `email`, `name`, `created_at`, `updated_at`)
VALUES (
  'staging_user_sarah',
  'sarah.mitchell@example.org',
  'Sarah Mitchell',
  unixepoch(),
  unixepoch()
);
--> statement-breakpoint
INSERT OR IGNORE INTO `donors` (
  `id`,
  `display_name`,
  `email`,
  `phone`,
  `location`,
  `relationship_summary`,
  `institutional_memory`,
  `relationship_health`,
  `preferred_communication`,
  `interests`,
  `family`,
  `created_at`,
  `updated_at`
) VALUES (
  'elena-chen',
  'Elena & David Chen',
  'elena.chen@example.org',
  '(617) 555-0148',
  'Boston, MA',
  'Longstanding scholarship partners who value specific student stories and substantive progress updates.',
  'Elena attended college on scholarship. Their fictional daughter Lily graduated in 2016.',
  82,
  'Personal email with concise, substantive updates',
  '["First-generation students","Student research"]',
  '{"daughter":"Lily","anniversary":"August 3"}',
  unixepoch(),
  unixepoch()
);
--> statement-breakpoint
INSERT OR IGNORE INTO `interactions` (
  `id`,
  `donor_id`,
  `user_id`,
  `type`,
  `occurred_at`,
  `summary`,
  `source`,
  `created_at`,
  `updated_at`
) VALUES (
  'staging_interaction_reception',
  'elena-chen',
  'staging_user_sarah',
  'meeting',
  unixepoch('now', '-14 days'),
  'Scholarship reception follow-up\nSpoke with a fictional scholarship recipient and requested a concise outcomes update.',
  'seed',
  unixepoch(),
  unixepoch()
);
--> statement-breakpoint
INSERT OR IGNORE INTO `gifts` (
  `id`,
  `donor_id`,
  `amount_cents`,
  `fund`,
  `received_at`,
  `acknowledged_at`,
  `created_at`,
  `updated_at`
) VALUES (
  'staging_gift_chen_scholarship',
  'elena-chen',
  2500000,
  'Scholarship Fund',
  unixepoch('now', '-120 days'),
  unixepoch('now', '-119 days'),
  unixepoch(),
  unixepoch()
);
--> statement-breakpoint
INSERT OR IGNORE INTO `recommendations` (
  `id`,
  `donor_id`,
  `user_id`,
  `action`,
  `reason`,
  `score`,
  `status`,
  `due_at`,
  `created_at`,
  `updated_at`
) VALUES (
  'staging_recommendation_chen_follow_up',
  'elena-chen',
  'staging_user_sarah',
  'Send the scholarship outcomes brief',
  'Sample next action created from the staging relationship history.',
  94,
  'open',
  unixepoch('now', '+1 day'),
  unixepoch(),
  unixepoch()
);
