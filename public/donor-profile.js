import {
  donorDisplayName,
  donorSecondaryHousehold,
  formatCrmDate,
  formatCurrency,
  isOverdueNextAction
} from './crm-donors.js';

export const PROFILE_EMPTY_VALUE = 'Not recorded';
export const TIMELINE_FILTERS = Object.freeze(['all', 'gift', 'activity', 'note', 'campaign']);

function clean(value) {
  return String(value ?? '').trim();
}

function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  return clean(value).slice(0, 10);
}

function fiscalYearForDate(value) {
  const parsed = timestamp(value);
  if (parsed === null) return null;
  const date = new Date(parsed);
  return date.getUTCMonth() >= 6 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

function currentFiscalYear(today = new Date()) {
  return today.getUTCMonth() >= 6 ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
}

function sortNewestFirst(rows = []) {
  return [...rows].sort((left, right) => {
    const leftTime = timestamp(left.date);
    const rightTime = timestamp(right.date);
    if (leftTime === null && rightTime === null) return 0;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  });
}

export function profileValue(value, emptyValue = PROFILE_EMPTY_VALUE) {
  return clean(value) || emptyValue;
}

export function formatDonorAddress(row = {}) {
  const cityAndState = [clean(row.city), clean(row.state)].filter(Boolean).join(', ');
  const locality = [cityAndState, clean(row.zip)].filter(Boolean).join(' ');
  return [
    clean(row.address),
    locality,
    clean(row.country)
  ].filter(Boolean).join('\n');
}

export function archivedDonorActionLabel(row = {}) {
  return row.is_archived ? 'Restore Donor' : 'Archive Donor';
}

export function donorProfileViewModel(row = {}) {
  const phones = [clean(row.mobile_phone), clean(row.home_phone)]
    .filter((phone, index, values) => phone && values.indexOf(phone) === index);
  const address = formatDonorAddress(row);
  const notes = clean(row.notes);

  return {
    displayName: donorDisplayName(row),
    householdName: donorSecondaryHousehold(row),
    donorCode: profileValue(row.donor_code, 'No donor code'),
    isArchived: Boolean(row.is_archived),
    archiveActionLabel: archivedDonorActionLabel(row),
    stage: profileValue(row.stage),
    assignedOfficer: profileValue(row.assigned_officer, 'Unassigned'),
    lifetimeGiving: formatCurrency(row.lifetime_giving) || PROFILE_EMPTY_VALUE,
    lastGiftAmount: formatCurrency(row.last_gift_amount) || PROFILE_EMPTY_VALUE,
    lastGiftDate: formatCrmDate(row.last_gift_date) || PROFILE_EMPTY_VALUE,
    lastContactDate: formatCrmDate(row.last_contact_date) || PROFILE_EMPTY_VALUE,
    nextAction: profileValue(row.next_action, 'No next action'),
    nextActionDate: formatCrmDate(row.next_action_date) || PROFILE_EMPTY_VALUE,
    primaryEmail: profileValue(row.email),
    primaryPhone: phones[0] || PROFILE_EMPTY_VALUE,
    secondaryPhone: phones[1] || '',
    address: address || PROFILE_EMPTY_VALUE,
    notes,
    notesEmpty: !notes
  };
}

export function donorGivingSummary(donor = {}, gifts = [], today = new Date()) {
  const usableGifts = gifts
    .filter(gift => !gift.is_deleted)
    .map(gift => ({
      ...gift,
      amountValue: amount(gift.amount),
      date: gift.gift_date || gift.received_at || gift.created_at
    }))
    .filter(gift => gift.amountValue !== null);
  const sorted = [...usableGifts].sort((left, right) => (timestamp(right.date) ?? 0) - (timestamp(left.date) ?? 0));
  const fiscalYear = currentFiscalYear(today);
  const totalFromGifts = usableGifts.reduce((sum, gift) => sum + gift.amountValue, 0);
  const lifetime = usableGifts.length ? totalFromGifts : amount(donor.lifetime_giving);
  const currentYear = usableGifts
    .filter(gift => fiscalYearForDate(gift.date) === fiscalYear)
    .reduce((sum, gift) => sum + gift.amountValue, 0);
  const previousYear = usableGifts
    .filter(gift => fiscalYearForDate(gift.date) === fiscalYear - 1)
    .reduce((sum, gift) => sum + gift.amountValue, 0);
  const mostRecent = sorted[0];
  const largest = usableGifts.reduce((best, gift) => (!best || gift.amountValue > best.amountValue ? gift : best), null);
  const fallbackLastGift = amount(donor.last_gift_amount);
  const fallbackLastDate = donor.last_gift_date;

  return {
    lifetimeGiving: lifetime !== null ? formatCurrency(lifetime) : PROFILE_EMPTY_VALUE,
    currentFiscalYearGiving: usableGifts.length ? formatCurrency(currentYear) : PROFILE_EMPTY_VALUE,
    previousFiscalYearGiving: usableGifts.length ? formatCurrency(previousYear) : PROFILE_EMPTY_VALUE,
    mostRecentGift: mostRecent
      ? `${formatCurrency(mostRecent.amountValue)}${formatCrmDate(dateOnly(mostRecent.date)) ? ` · ${formatCrmDate(dateOnly(mostRecent.date))}` : ''}`
      : fallbackLastGift !== null ? `${formatCurrency(fallbackLastGift)}${formatCrmDate(fallbackLastDate) ? ` · ${formatCrmDate(fallbackLastDate)}` : ''}` : PROFILE_EMPTY_VALUE,
    largestGift: largest ? formatCurrency(largest.amountValue) : fallbackLastGift !== null ? formatCurrency(fallbackLastGift) : PROFILE_EMPTY_VALUE,
    averageGift: usableGifts.length ? formatCurrency(totalFromGifts / usableGifts.length) : PROFILE_EMPTY_VALUE,
    numberOfGifts: usableGifts.length ? String(usableGifts.length) : fallbackLastGift !== null ? '1' : '0',
    hasGiftLedger: usableGifts.length > 0
  };
}

export function donorFundraisingSnapshot(donor = {}, activities = [], gifts = [], today = new Date()) {
  const activeActivities = activities.filter(activity => !activity.is_archived);
  const latestActivity = sortNewestFirst(activeActivities.map(activity => ({
    date: activity.occurred_at || activity.created_at,
    description: clean(activity.subject) || clean(activity.notes) || 'Activity'
  })))[0];
  const nextActivity = sortNewestFirst(activeActivities
    .filter(activity => clean(activity.next_action) || clean(activity.next_action_date))
    .map(activity => ({
      date: activity.next_action_date || activity.occurred_at,
      description: clean(activity.next_action) || clean(activity.subject) || 'Scheduled action'
    })))[0];
  const latestCampaignGift = sortNewestFirst(gifts
    .filter(gift => clean(gift.campaign))
    .map(gift => ({ date: gift.gift_date || gift.created_at, description: clean(gift.campaign) })))[0];

  return {
    currentAskAmount: '',
    currentCampaign: latestCampaignGift?.description || '',
    lastMeaningfulInteraction: latestActivity
      ? `${latestActivity.description}${formatCrmDate(dateOnly(latestActivity.date)) ? ` · ${formatCrmDate(dateOnly(latestActivity.date))}` : ''}`
      : formatCrmDate(donor.last_contact_date) || PROFILE_EMPTY_VALUE,
    nextScheduledAction: nextActivity
      ? `${nextActivity.description}${formatCrmDate(dateOnly(nextActivity.date)) ? ` · ${formatCrmDate(dateOnly(nextActivity.date))}` : ''}`
      : profileValue(donor.next_action, 'No scheduled action'),
    overdueFollowUp: isOverdueNextAction(donor, today),
    openActivities: activeActivities.length
  };
}

export function donorUnifiedTimeline({ donor = {}, gifts = [], activities = [] } = {}) {
  const giftItems = gifts.filter(gift => !gift.is_deleted).map(gift => ({
    id: `gift-${gift.id || gift.gift_date || gift.created_at}`,
    type: 'gift',
    date: gift.gift_date || gift.created_at,
    title: 'Gift',
    description: clean(gift.notes) || clean(gift.campaign) || clean(gift.gift_type) || 'Gift recorded',
    amount: amount(gift.amount),
    user: clean(gift.created_by) || clean(gift.owner_user_id)
  }));
  const activityItems = activities.filter(activity => !activity.is_archived).map(activity => ({
    id: `activity-${activity.id}`,
    type: activity.activity_type === 'note' ? 'note' : 'activity',
    date: activity.occurred_at || activity.created_at,
    title: activity.activity_type === 'note' ? 'Note' : 'Activity',
    description: clean(activity.subject) || clean(activity.notes) || 'Activity recorded',
    amount: null,
    user: clean(activity.created_by)
  }));
  const donorNoteItems = clean(donor.notes) ? [{
    id: `donor-note-${donor.id || 'profile'}`,
    type: 'note',
    date: donor.updated_at || donor.created_at,
    title: 'Profile Note',
    description: clean(donor.notes),
    amount: null,
    user: ''
  }] : [];
  const campaignItems = gifts.filter(gift => !gift.is_deleted && clean(gift.campaign)).map(gift => ({
    id: `campaign-${gift.id || gift.campaign}`,
    type: 'campaign',
    date: gift.gift_date || gift.created_at,
    title: 'Campaign',
    description: clean(gift.campaign),
    amount: amount(gift.amount),
    user: clean(gift.created_by) || clean(gift.owner_user_id)
  }));
  return sortNewestFirst([...giftItems, ...activityItems, ...donorNoteItems, ...campaignItems]);
}

export function filterUnifiedTimeline(items = [], filter = 'all') {
  return filter === 'all' || !TIMELINE_FILTERS.includes(filter)
    ? [...items]
    : items.filter(item => item.type === filter);
}
