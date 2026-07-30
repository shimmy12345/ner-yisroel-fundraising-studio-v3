import { formatCrmDate } from './crm-donors.js';

export const ACTIVITY_PAGE_SIZE = 50;

export const ACTIVITY_FIELDS = [
  'id',
  'donor_id',
  'activity_type',
  'occurred_at',
  'subject',
  'notes',
  'outcome',
  'next_action',
  'next_action_date',
  'next_action_completed_at',
  'next_action_completed_by',
  'is_archived',
  'created_by',
  'created_at',
  'updated_at'
];

export const ACTIVITY_TYPES = Object.freeze({
  phone_call: { label: 'Phone Call', marker: 'CALL' },
  meeting: { label: 'Meeting', marker: 'MEET' },
  email: { label: 'Email', marker: 'EMAIL' },
  text_message: { label: 'Text Message', marker: 'TEXT' },
  letter: { label: 'Letter', marker: 'LETTER' },
  event: { label: 'Event', marker: 'EVENT' },
  note: { label: 'Internal Note', marker: 'NOTE' },
  other: { label: 'Other', marker: 'OTHER' }
});

export const CONTACT_ACTIVITY_TYPES = Object.freeze([
  'phone_call',
  'meeting',
  'email',
  'text_message',
  'letter',
  'event'
]);

const occurredFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

function clean(value) {
  return String(value ?? '').trim();
}

function validDateOnly(value) {
  const input = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function activityTypeLabel(type) {
  return ACTIVITY_TYPES[type]?.label || 'Other';
}

export function isContactActivity(type) {
  return CONTACT_ACTIVITY_TYPES.includes(type);
}

export function activityArchiveActionLabel(activity = {}) {
  return activity.is_archived ? 'Restore Activity' : 'Archive Activity';
}

export function activityTimelineEmptyState(archived = false) {
  return archived
    ? {
        title: 'No archived activities',
        message: 'Archived activities will appear here and can be restored at any time.'
      }
    : {
        title: 'No activity yet',
        message: 'Add the first activity to begin this donor’s relationship timeline.'
      };
}

export function nextActionGuidance(nextAction, nextActionDate) {
  const hasAction = Boolean(clean(nextAction));
  const hasDate = Boolean(clean(nextActionDate));
  return hasAction !== hasDate
    ? 'You can save this activity, but adding both a next action and date makes follow-up clearer.'
    : '';
}

export function toDateTimeLocalValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 16);
}

export function normalizeActivityPayload(input = {}, donorId) {
  const donor_id = clean(donorId);
  const activity_type = clean(input.activity_type);
  const subject = clean(input.subject);
  const notes = clean(input.notes);
  const occurred = new Date(input.occurred_at);
  const nextActionDate = clean(input.next_action_date);

  if (!donor_id) throw new Error('A donor is required.');
  if (!ACTIVITY_TYPES[activity_type]) throw new Error('Choose a valid activity type.');
  if (!Number.isFinite(occurred.getTime())) throw new Error('Enter a valid activity date and time.');
  if (!subject) throw new Error('Subject is required.');
  if (!notes) throw new Error('Notes are required.');
  if (nextActionDate && !validDateOnly(nextActionDate)) throw new Error('Enter a valid next action date.');

  return {
    donor_id,
    activity_type,
    occurred_at: occurred.toISOString(),
    subject,
    notes,
    outcome: clean(input.outcome) || null,
    next_action: clean(input.next_action) || null,
    next_action_date: nextActionDate || null
  };
}

export function sortActivitiesNewestFirst(activities = []) {
  return [...activities].sort((left, right) => {
    const leftTime = Date.parse(left?.occurred_at);
    const rightTime = Date.parse(right?.occurred_at);
    if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
    if (!Number.isFinite(leftTime)) return 1;
    if (!Number.isFinite(rightTime)) return -1;
    return rightTime - leftTime;
  });
}

export function activityTimelineViewModel(activity = {}) {
  const type = ACTIVITY_TYPES[activity.activity_type] || ACTIVITY_TYPES.other;
  const occurred = new Date(activity.occurred_at);
  return {
    ...activity,
    typeLabel: type.label,
    typeMarker: type.marker,
    occurredLabel: Number.isFinite(occurred.getTime()) ? occurredFormatter.format(occurred) : 'Date not recorded',
    nextActionDateLabel: formatCrmDate(activity.next_action_date),
    archiveActionLabel: activityArchiveActionLabel(activity)
  };
}
