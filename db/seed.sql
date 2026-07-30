INSERT INTO users (id, email, name, created_at, updated_at)
VALUES ('user_sarah', 'sarah@example.org', 'Sarah Mitchell', unixepoch(), unixepoch());

INSERT INTO donors (
  id, display_name, email, phone, location, relationship_summary,
  institutional_memory, relationship_health, preferred_communication,
  interests, family, created_at, updated_at
) VALUES (
  'elena-chen', 'Elena & David Chen', 'elena.chen@example.org',
  '(617) 555-0148', 'Boston, MA',
  'Longstanding scholarship partners who value specific student stories.',
  'Elena attended on scholarship. Their daughter Lily graduated in 2016.',
  82, 'Personal email with concise, substantive updates',
  '["First-generation students","Student research"]',
  '{"daughter":"Lily","anniversary":"August 3"}',
  unixepoch(), unixepoch()
);

INSERT INTO interactions (
  id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at
) VALUES (
  'interaction_reception', 'elena-chen', 'user_sarah', 'meeting',
  unixepoch('2026-06-12'), 'Attended scholarship reception and spoke with Maya Rodriguez.',
  'seed', unixepoch(), unixepoch()
);

INSERT INTO gifts (
  id, donor_id, amount_cents, fund, received_at, acknowledged_at, created_at, updated_at
) VALUES (
  'gift_chen_2026', 'elena-chen', 2500000, 'Scholarship Fund',
  unixepoch('2026-03-18'), unixepoch('2026-03-19'), unixepoch(), unixepoch()
);

INSERT INTO recommendations (
  id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at
) VALUES (
  'recommendation_chen_meeting', 'elena-chen', 'user_sarah',
  'Prepare for today''s meeting',
  'Opened the last three updates and attended the recent scholarship reception.',
  96, 'open', unixepoch('2026-07-30 14:00:00'), unixepoch(), unixepoch()
);
