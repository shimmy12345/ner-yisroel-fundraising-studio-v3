import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_TYPES,
  activityArchiveActionLabel,
  activityTimelineEmptyState,
  activityTimelineViewModel,
  activityTypeLabel,
  isContactActivity,
  nextActionGuidance,
  normalizeActivityPayload,
  sortActivitiesNewestFirst,
  toDateTimeLocalValue
} from '../public/donor-activities.js';

test('maps every Phase 1 activity type to its accessible UI label', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ACTIVITY_TYPES).map(([value, option]) => [value, option.label])),
    {
      phone_call: 'Phone Call',
      meeting: 'Meeting',
      email: 'Email',
      text_message: 'Text Message',
      letter: 'Letter',
      event: 'Event',
      note: 'Internal Note',
      other: 'Other'
    }
  );
  assert.equal(activityTypeLabel('meeting'), 'Meeting');
  assert.equal(activityTypeLabel('unsupported'), 'Other');
});

test('recognizes contact activities without treating notes or other as contact', () => {
  for (const type of ['phone_call', 'meeting', 'email', 'text_message', 'letter', 'event']) {
    assert.equal(isContactActivity(type), true, type);
  }
  assert.equal(isContactActivity('note'), false);
  assert.equal(isContactActivity('other'), false);
});

test('normalizes an activity payload and allows partial next-action details', () => {
  const payload = normalizeActivityPayload({
    activity_type: 'phone_call',
    occurred_at: '2026-07-29T10:30:00-04:00',
    subject: '  Scholarship follow-up ',
    notes: '  Discussed the fall campaign. ',
    outcome: '  Interested ',
    next_action: '',
    next_action_date: '2026-08-05'
  }, ' 9f617763-9a45-4df9-b790-737d2888bc44 ');
  assert.deepEqual(payload, {
    donor_id: '9f617763-9a45-4df9-b790-737d2888bc44',
    activity_type: 'phone_call',
    occurred_at: '2026-07-29T14:30:00.000Z',
    subject: 'Scholarship follow-up',
    notes: 'Discussed the fall campaign.',
    outcome: 'Interested',
    next_action: null,
    next_action_date: '2026-08-05'
  });
  assert.match(nextActionGuidance('', '2026-08-05'), /both a next action and date/i);
  assert.doesNotThrow(() => normalizeActivityPayload({
    activity_type: 'note',
    occurred_at: '2026-07-29T10:30',
    subject: 'Internal context',
    notes: 'Board connection'
  }, 'donor-id'));
});

test('rejects invalid types and missing required activity fields', () => {
  const valid = {
    activity_type: 'email',
    occurred_at: '2026-07-29T10:30',
    subject: 'Subject',
    notes: 'Notes'
  };
  assert.throws(() => normalizeActivityPayload({ ...valid, activity_type: 'gift' }, 'donor'), /valid activity type/i);
  assert.throws(() => normalizeActivityPayload({ ...valid, subject: '' }, 'donor'), /Subject is required/i);
  assert.throws(() => normalizeActivityPayload({ ...valid, notes: '' }, 'donor'), /Notes are required/i);
  assert.throws(() => normalizeActivityPayload({ ...valid, occurred_at: '' }, 'donor'), /valid activity date/i);
});

test('provides archive labels and useful empty states', () => {
  assert.equal(activityArchiveActionLabel({ is_archived: false }), 'Archive Activity');
  assert.equal(activityArchiveActionLabel({ is_archived: true }), 'Restore Activity');
  assert.match(activityTimelineEmptyState(false).title, /No activity/i);
  assert.match(activityTimelineEmptyState(true).title, /No archived/i);
});

test('uses reverse chronological timeline ordering and a 50-row page', () => {
  const rows = [
    { id: 'older', occurred_at: '2026-07-01T12:00:00Z' },
    { id: 'newest', occurred_at: '2026-07-29T12:00:00Z' },
    { id: 'middle', occurred_at: '2026-07-15T12:00:00Z' }
  ];
  assert.deepEqual(sortActivitiesNewestFirst(rows).map(row => row.id), ['newest', 'middle', 'older']);
  assert.equal(ACTIVITY_PAGE_SIZE, 50);
});

test('builds timeline labels and local datetime form values', () => {
  const view = activityTimelineViewModel({
    activity_type: 'text_message',
    occurred_at: '2026-07-29T12:00:00Z',
    next_action_date: '2026-08-01',
    is_archived: true
  });
  assert.equal(view.typeLabel, 'Text Message');
  assert.equal(view.typeMarker, 'TEXT');
  assert.equal(view.nextActionDateLabel, 'Aug 1, 2026');
  assert.equal(view.archiveActionLabel, 'Restore Activity');
  assert.match(toDateTimeLocalValue('2026-07-29T12:00:00Z'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});
