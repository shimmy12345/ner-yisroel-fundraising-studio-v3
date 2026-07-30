const DAY_MS = 86_400_000;

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
});

function clean(value) {
  return String(value ?? '').trim();
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnlyTimestamp(value) {
  const input = clean(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const parsed = Date.parse(`${input}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfUtcDay(value = new Date()) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function donorName(row = {}) {
  const first = clean(row.first_name);
  const last = clean(row.last_name);
  if (first && last) return `${first} ${last}`;
  return first || last || clean(row.household_name) || clean(row.donor_code) || 'Unnamed donor';
}

function donorLookup(donors = []) {
  return new Map(donors.map(donor => [donor.id, donorName(donor)]));
}

function formatDate(value) {
  const parsed = dateOnlyTimestamp(value) ?? timestamp(value);
  return parsed === null ? 'Date not recorded' : shortDateFormatter.format(new Date(parsed));
}

function actionItem({ title, donor, dueDate, kind, detail, sourceId, sourceType, score = 0 }) {
  return {
    id: `${kind}-${sourceId || title}-${dueDate || ''}`,
    title,
    donor,
    dueDate,
    dueLabel: dueDate ? formatDate(dueDate) : 'No due date',
    kind,
    detail,
    reason: detail,
    sourceId,
    sourceType,
    score
  };
}

function daysBetween(earlier, later) {
  return Math.max(0, Math.floor((later - earlier) / DAY_MS));
}

function scoredFollowUp(row, donor, today, sourceType, sourceId, title, detail = '') {
  const dueAt = dateOnlyTimestamp(row.next_action_date);
  const lastContactAt = dateOnlyTimestamp(row.last_contact_date);
  const giving = Number(row.lifetime_giving || row.last_gift_amount || 0);
  let score = 10;
  let kind = 'outstanding';
  let reason = detail || 'Open follow-up';

  if (dueAt !== null && dueAt < today) {
    const daysOverdue = daysBetween(dueAt, today);
    score += 100 + Math.min(daysOverdue, 60);
    kind = 'overdue';
    reason = `Follow-up is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue`;
  } else if (dueAt === today) {
    score += 90;
    kind = 'today';
    reason = 'Follow-up is due today';
  } else if (dueAt === null) {
    score += 25;
    reason = 'Open follow-up has no due date';
  }

  if (lastContactAt !== null && lastContactAt < today - (90 * DAY_MS)) {
    const contactDays = daysBetween(lastContactAt, today);
    score += 25;
    if (kind === 'outstanding') reason = `No meaningful contact in ${contactDays} days`;
  }
  if (Number.isFinite(giving) && giving > 0) score += Math.min(25, Math.log10(giving + 1) * 6);

  return actionItem({
    title,
    donor,
    dueDate: row.next_action_date,
    kind,
    detail: reason,
    sourceId,
    sourceType,
    score
  });
}

function buildPriorities(donors, activities, today) {
  const names = donorLookup(donors);
  const due = [];

  donors.filter(row => !row.is_archived && !row.next_action_completed_at && clean(row.next_action)).forEach(row => {
    const dueAt = dateOnlyTimestamp(row.next_action_date);
    if (dueAt === null || dueAt <= today) {
      due.push(scoredFollowUp(row, donorName(row), today, 'donor', row.id, clean(row.next_action)));
    }
  });

  activities.filter(row => !row.is_archived && !row.next_action_completed_at && clean(row.next_action)).forEach(row => {
    const dueAt = dateOnlyTimestamp(row.next_action_date);
    if (dueAt === null || dueAt <= today) {
      due.push(scoredFollowUp(
        row,
        names.get(row.donor_id) || 'Donor activity',
        today,
        'activity',
        row.id,
        clean(row.next_action),
        clean(row.subject) || 'Activity follow-up'
      ));
    }
  });

  activities.filter(row => {
    const occurred = timestamp(row.occurred_at);
    return !row.is_archived
      && !row.next_action_completed_at
      && !clean(row.next_action)
      && row.activity_type === 'meeting'
      && occurred !== null
      && occurred >= today
      && occurred < today + (2 * DAY_MS);
  }).forEach(row => {
    const occurred = timestamp(row.occurred_at);
    const tomorrow = occurred >= today + DAY_MS;
    due.push(actionItem({
      title: clean(row.subject) || 'Donor meeting',
      donor: names.get(row.donor_id) || 'Donor meeting',
      dueDate: clean(row.occurred_at).slice(0, 10),
      kind: 'meeting',
      detail: tomorrow ? 'Meeting scheduled tomorrow' : 'Meeting scheduled today',
      sourceId: row.id,
      sourceType: 'meeting',
      score: tomorrow ? 70 : 85
    }));
  });

  return due
    .sort((left, right) => {
      const score = right.score - left.score;
      if (score) return score;
      return (dateOnlyTimestamp(left.dueDate) ?? Number.MAX_SAFE_INTEGER)
        - (dateOnlyTimestamp(right.dueDate) ?? Number.MAX_SAFE_INTEGER);
    })
    .slice(0, 8);
}

function buildUpcoming(donors, activities, today) {
  const names = donorLookup(donors);
  const upcoming = [];

  donors.filter(row => !row.is_archived && !row.next_action_completed_at && clean(row.next_action)).forEach(row => {
    const dueAt = dateOnlyTimestamp(row.next_action_date);
    if (dueAt !== null && dueAt > today) {
      upcoming.push(actionItem({
        title: clean(row.next_action),
        donor: donorName(row),
        dueDate: row.next_action_date,
        kind: 'follow-up',
        detail: 'Scheduled follow-up',
        sourceId: row.id,
        sourceType: 'donor'
      }));
    }
  });

  activities.filter(row => !row.is_archived && !row.next_action_completed_at).forEach(row => {
    const nextActionAt = dateOnlyTimestamp(row.next_action_date);
    if (clean(row.next_action) && nextActionAt !== null && nextActionAt > today) {
      upcoming.push(actionItem({
        title: clean(row.next_action),
        donor: names.get(row.donor_id) || 'Donor activity',
        dueDate: row.next_action_date,
        kind: 'reminder',
        detail: clean(row.subject) || 'Activity reminder',
        sourceId: row.id,
        sourceType: 'activity'
      }));
    }

    const occurred = timestamp(row.occurred_at);
    if (row.activity_type === 'meeting' && occurred !== null && occurred >= today + DAY_MS) {
      upcoming.push(actionItem({
        title: clean(row.subject) || 'Donor meeting',
        donor: names.get(row.donor_id) || 'Donor meeting',
        dueDate: clean(row.occurred_at).slice(0, 10),
        kind: 'meeting',
        detail: 'Upcoming meeting',
        sourceId: row.id,
        sourceType: 'meeting'
      }));
    }
  });

  return upcoming
    .sort((left, right) => dateOnlyTimestamp(left.dueDate) - dateOnlyTimestamp(right.dueDate))
    .slice(0, 6);
}

function buildRecentActivity(donors, activities, knowledge, generations, gifts) {
  const names = donorLookup(donors);
  const items = [];

  donors.forEach(row => {
    const createdAt = timestamp(row.created_at);
    if (createdAt !== null) {
      items.push({
        id: `donor-${row.id}`,
        type: 'donor',
        title: `${donorName(row)} added`,
        detail: 'New donor record',
        occurredAt: row.created_at
      });
    }
  });

  activities.filter(row => !row.is_archived).forEach(row => {
    items.push({
      id: `activity-${row.id}`,
      type: row.activity_type || 'activity',
      title: clean(row.subject) || 'Donor activity logged',
      detail: `${names.get(row.donor_id) || 'Donor'} · ${clean(row.activity_type).replaceAll('_', ' ')}`,
      occurredAt: row.occurred_at
    });
  });

  knowledge.forEach(row => {
    items.push({
      id: `knowledge-${row.id}`,
      type: 'knowledge',
      title: clean(row.title) || 'Knowledge updated',
      detail: row.source_type === 'upload' ? 'Knowledge document uploaded' : 'Knowledge note updated',
      occurredAt: row.updated_at || row.created_at
    });
  });

  generations.forEach(row => {
    items.push({
      id: `generation-${row.id}`,
      type: 'ai',
      title: clean(row.title) || 'AI conversation generated',
      detail: clean(row.mode).replaceAll('_', ' ') || 'AI Studio',
      occurredAt: row.created_at
    });
  });

  gifts.filter(row => !row.is_deleted).forEach(row => {
    items.push({
      id: `gift-${row.id}`,
      type: 'gift',
      title: `${currencyFormatter.format(Number(row.amount) || 0)} gift recorded`,
      detail: `${names.get(row.donor_id) || 'Donor'}${clean(row.campaign) ? ` · ${clean(row.campaign)}` : ''}`,
      occurredAt: row.created_at || `${row.gift_date}T00:00:00Z`
    });
  });

  return items
    .filter(item => timestamp(item.occurredAt) !== null)
    .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt))
    .slice(0, 8);
}

export function formatDashboardValue(value, kind = 'number') {
  if (kind === 'currency') return currencyFormatter.format(Number(value) || 0);
  return compactNumberFormatter.format(Number(value) || 0);
}

export function buildDashboardViewModel({
  donors = [],
  activities = [],
  knowledge = [],
  generations = [],
  gifts = [],
  totals = {}
} = {}, now = new Date()) {
  const today = startOfUtcDay(now);
  const activeDonors = donors.filter(row => !row.is_archived);
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  const recentStart = today - (90 * DAY_MS);
  const activeStart = today - (30 * DAY_MS);
  const staleBefore = today - (90 * DAY_MS);

  const donorGiftFallback = activeDonors.filter(row => {
    const giftDate = dateOnlyTimestamp(row.last_gift_date);
    return giftDate !== null && giftDate >= yearStart && giftDate <= today;
  });
  const ytdGiftRows = gifts.length
    ? gifts.filter(row => {
        const giftDate = dateOnlyTimestamp(row.gift_date);
        return !row.is_deleted && giftDate !== null && giftDate >= yearStart && giftDate <= today;
      })
    : donorGiftFallback;
  const totalRaisedYtd = ytdGiftRows.reduce((sum, row) => {
    const amount = Number(row.amount ?? row.last_gift_amount);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const openActions = activeDonors.filter(row => !row.next_action_completed_at && clean(row.next_action)).length
    + activities.filter(row => !row.is_archived && !row.next_action_completed_at && clean(row.next_action)).length;
  const recentGifts = gifts.length
    ? gifts.filter(row => {
        const giftDate = dateOnlyTimestamp(row.gift_date);
        return !row.is_deleted && giftDate !== null && giftDate >= recentStart && giftDate <= today;
      })
    : activeDonors.filter(row => {
        const giftDate = dateOnlyTimestamp(row.last_gift_date);
        return giftDate !== null && giftDate >= recentStart && giftDate <= today;
      });
  const addedRecently = activeDonors.filter(row => {
    const createdAt = timestamp(row.created_at);
    return createdAt !== null && createdAt >= activeStart;
  }).length;
  const dueToday = activeDonors.filter(row => !row.next_action_completed_at && dateOnlyTimestamp(row.next_action_date) === today).length
    + activities.filter(row => !row.is_archived && !row.next_action_completed_at && dateOnlyTimestamp(row.next_action_date) === today).length;

  const overdue = activeDonors.filter(row => {
    const dueAt = dateOnlyTimestamp(row.next_action_date);
    return !row.next_action_completed_at && dueAt !== null && dueAt < today;
  });
  const stale = activeDonors.filter(row => {
    const contactAt = dateOnlyTimestamp(row.last_contact_date);
    return contactAt !== null && contactAt < staleBefore;
  });
  const stewardship = activeDonors.filter(row => {
    const giftAt = dateOnlyTimestamp(row.last_gift_date);
    return giftAt !== null && giftAt >= activeStart && !clean(row.next_action);
  });
  const recentlyActive = activeDonors.filter(row => {
    const contactAt = dateOnlyTimestamp(row.last_contact_date);
    return contactAt !== null && contactAt >= activeStart && contactAt <= today;
  });
  const missingNotes = activeDonors.filter(row => !clean(row.notes));
  const totalValue = (name, fallback) => Number.isFinite(Number(totals[name]))
    ? Number(totals[name])
    : fallback;
  const priorities = buildPriorities(activeDonors, activities, today);
  const upcoming = buildUpcoming(activeDonors, activities, today);
  const names = donorLookup(activeDonors);
  const meetings = activities.filter(row => {
    const occurred = timestamp(row.occurred_at);
    return !row.is_archived
      && row.activity_type === 'meeting'
      && occurred !== null
      && occurred >= today
      && occurred < today + (7 * DAY_MS);
  });
  const completed = [
    ...activeDonors.filter(row => row.next_action_completed_at).map(row => ({
      id: `completed-donor-${row.id}`,
      title: clean(row.next_action) || 'Donor follow-up',
      donor: donorName(row),
      completedAt: row.next_action_completed_at,
      sourceType: 'donor'
    })),
    ...activities.filter(row => row.next_action_completed_at).map(row => ({
      id: `completed-activity-${row.id}`,
      title: clean(row.next_action) || clean(row.subject) || 'Activity follow-up',
      donor: names.get(row.donor_id) || 'Donor activity',
      completedAt: row.next_action_completed_at,
      sourceType: 'activity'
    }))
  ].sort((left, right) => timestamp(right.completedAt) - timestamp(left.completedAt)).slice(0, 8);

  return {
    isSample: false,
    kpis: [
      {
        icon: 'giving',
        title: 'Total Raised (YTD)',
        value: formatDashboardValue(totalValue('total_raised_ytd', totalRaisedYtd), 'currency'),
        trend: `${totalValue('ytd_gift_count', ytdGiftRows.length)} recorded gift${totalValue('ytd_gift_count', ytdGiftRows.length) === 1 ? '' : 's'}`,
        tone: 'positive'
      },
      {
        icon: 'donors',
        title: 'Active Donors',
        value: formatDashboardValue(totalValue('active_donors', activeDonors.length)),
        trend: `${addedRecently} added in the last 30 days`,
        tone: 'neutral'
      },
      {
        icon: 'tasks',
        title: 'Open Actions',
        value: formatDashboardValue(totalValue('open_actions', openActions)),
        trend: `${totalValue('due_today', dueToday)} due today`,
        tone: totalValue('due_today', dueToday) ? 'attention' : 'positive'
      },
      {
        icon: 'gift',
        title: 'Recent Gifts',
        value: formatDashboardValue(totalValue('recent_gifts', recentGifts.length)),
        trend: 'Recorded in the last 90 days',
        tone: 'neutral'
      }
    ],
    morningBrief: {
      dueToday: totalValue('due_today', dueToday),
      overdue: totalValue('overdue', overdue.length),
      meetings: totalValue('meetings_next_seven_days', meetings.length),
      recentGifts: totalValue('recent_gifts', recentGifts.length),
      needsFollowUp: overdue.length + stewardship.length,
      unresolved: priorities.length,
      summary: priorities.length
        ? `${totalValue('due_today', dueToday)} due today, ${totalValue('overdue', overdue.length)} overdue, and ${totalValue('meetings_next_seven_days', meetings.length)} meeting${totalValue('meetings_next_seven_days', meetings.length) === 1 ? '' : 's'} in the next seven days.`
        : 'No urgent fundraising priorities are currently recorded.'
    },
    priorities,
    completed,
    recentActivity: buildRecentActivity(activeDonors, activities, knowledge, generations, gifts),
    insights: [
      {
        tone: overdue.length ? 'attention' : 'positive',
        value: totalValue('overdue', overdue.length),
        title: 'Donors needing follow-up',
        detail: overdue.length ? 'Next actions are overdue.' : 'No donor follow-ups are overdue.'
      },
      {
        tone: stale.length ? 'attention' : 'positive',
        value: totalValue('stale_relationships', stale.length),
        title: 'Stale relationships',
        detail: stale.length ? 'No contact recorded in 90+ days.' : 'Recorded relationships are current.'
      },
      {
        tone: 'opportunity',
        value: stewardship.length,
        title: 'Stewardship opportunities',
        detail: 'Recent gifts without a recorded next action.'
      },
      {
        tone: 'positive',
        value: totalValue('recently_active', recentlyActive.length),
        title: 'Recently active donors',
        detail: 'Contact recorded in the last 30 days.'
      },
      {
        tone: missingNotes.length ? 'neutral' : 'positive',
        value: totalValue('missing_notes', missingNotes.length),
        title: 'Missing donor notes',
        detail: 'Active donor records without notes.'
      }
    ],
    upcoming
  };
}

export function sampleDashboardViewModel() {
  return {
    isSample: true,
    kpis: [
      { icon: 'giving', title: 'Total Raised (YTD)', value: '$0', trend: 'Example · connect live data', tone: 'neutral' },
      { icon: 'donors', title: 'Active Donors', value: '0', trend: 'Example · connect live data', tone: 'neutral' },
      { icon: 'tasks', title: 'Open Actions', value: '0', trend: 'Example · connect live data', tone: 'neutral' },
      { icon: 'gift', title: 'Recent Gifts', value: '0', trend: 'Example · connect live data', tone: 'neutral' }
    ],
    morningBrief: {
      dueToday: 0,
      overdue: 0,
      meetings: 0,
      recentGifts: 0,
      needsFollowUp: 0,
      unresolved: 0,
      summary: 'Live workspace data is unavailable.'
    },
    completed: [],
    priorities: [
      { id: 'sample-priority', title: 'Review today’s donor follow-ups', donor: 'Example task', dueLabel: 'Today', kind: 'today', detail: 'Example · live data unavailable' }
    ],
    recentActivity: [
      { id: 'sample-activity', type: 'activity', title: 'Recent workspace activity', detail: 'Example · live data unavailable', occurredAt: new Date().toISOString() }
    ],
    insights: [
      { tone: 'neutral', value: '—', title: 'Workspace insight', detail: 'Example · live data unavailable' }
    ],
    upcoming: [
      { id: 'sample-upcoming', title: 'Scheduled follow-ups appear here', donor: 'Example', dueLabel: 'Upcoming', kind: 'follow-up', detail: 'Example · live data unavailable' }
    ]
  };
}
