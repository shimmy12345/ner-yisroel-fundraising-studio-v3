import {
  donorDisplayName,
  donorSecondaryHousehold,
  formatCrmDate,
  formatCurrency
} from './crm-donors.js';

export const PROFILE_EMPTY_VALUE = 'Not recorded';

function clean(value) {
  return String(value ?? '').trim();
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
