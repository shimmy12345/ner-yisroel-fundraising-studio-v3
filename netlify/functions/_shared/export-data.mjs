import JSZip from 'jszip';

function xml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function readableHeader(value = '') {
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function scalar(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value ?? '';
}

export function csvForRows(rows = [], columns = []) {
  const keys = columns.length ? columns : [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  const quote = value => `"${String(scalar(value)).replaceAll('"', '""')}"`;
  return [
    keys.map(readableHeader).map(quote).join(','),
    ...rows.map(row => keys.map(key => quote(row?.[key])).join(','))
  ].join('\r\n');
}

function excelColumnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function worksheetXml(rows = [], columns = []) {
  const keys = columns.length ? [...columns] : [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  if (!keys.length) keys.push('status');
  const allRows = [
    Object.fromEntries(keys.map(key => [key, readableHeader(key)])),
    ...(rows.length ? rows : [{ status: 'No records' }])
  ];
  const rowXml = allRows.map((row, rowIndex) => {
    const cells = keys.map((key, columnIndex) => {
      const reference = `${excelColumnName(columnIndex)}${rowIndex + 1}`;
      const value = scalar(row[key]);
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${reference}"><v>${value}</v></c>`;
      }
      return `<c r="${reference}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function safeSheetName(value, index) {
  return String(value || `Sheet ${index + 1}`).replace(/[\\/*?:[\]]/g, '').slice(0, 31) || `Sheet ${index + 1}`;
}

export async function excelWorkbook(datasets = []) {
  const zip = new JSZip();
  const sheets = datasets.map((dataset, index) => ({
    ...dataset,
    sheetName: safeSheetName(dataset.name, index),
    sheetId: index + 1
  }));
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map(sheet => `<Override PartName="/xl/worksheets/sheet${sheet.sheetId}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.folder('xl').file('workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(sheet => `<sheet name="${xml(sheet.sheetName)}" sheetId="${sheet.sheetId}" r:id="rId${sheet.sheetId}"/>`).join('')}</sheets></workbook>`);
  zip.folder('xl').folder('_rels').file('workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map(sheet => `<Relationship Id="rId${sheet.sheetId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.sheetId}.xml"/>`).join('')}</Relationships>`);
  const worksheetFolder = zip.folder('xl').folder('worksheets');
  sheets.forEach(sheet => worksheetFolder.file(`sheet${sheet.sheetId}.xml`, worksheetXml(sheet.rows, sheet.columns || [])));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function clean(value) {
  return String(value ?? '').trim();
}

export function exportedDonorName(row = {}) {
  const preferredName = clean(row.preferred_name);
  const firstName = clean(row.first_name);
  const lastName = clean(row.last_name);
  const householdName = clean(row.household_name);
  const displayName = clean(row.display_name) || clean(row.full_name);
  if (displayName) return displayName;
  if (lastName && (preferredName || firstName)) return `${lastName}, ${preferredName || firstName}`;
  return lastName || preferredName || firstName || householdName || clean(row.donor_code) || '';
}

export const DONOR_EXPORT_COLUMNS = [
  'donor_id',
  'donor_code',
  'first_name',
  'last_name',
  'preferred_name',
  'full_name',
  'household_name',
  'email',
  'home_phone',
  'mobile_phone',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'assigned_officer',
  'stage',
  'lifetime_giving',
  'last_gift_amount',
  'last_gift_date',
  'last_contact_date',
  'next_action',
  'next_action_date',
  'is_archived',
  'created_at',
  'updated_at'
];

export const GIFT_EXPORT_COLUMNS = [
  'gift_id',
  'donor_id',
  'donor_name',
  'gift_date',
  'amount',
  'gift_type',
  'campaign',
  'pledge_id',
  'appeal',
  'payment_method',
  'check_number',
  'transaction_id',
  'recognition_name',
  'soft_credit_name',
  'shared_credit_amount',
  'notes',
  'created_at',
  'updated_at'
];

export const ACTIVITY_EXPORT_COLUMNS = [
  'activity_id',
  'donor_id',
  'donor_name',
  'activity_type',
  'occurred_at',
  'subject',
  'summary',
  'next_action',
  'next_action_date',
  'next_action_completed_at',
  'is_archived',
  'created_at',
  'updated_at'
];

export const CAMPAIGN_EXPORT_COLUMNS = ['gift_id', 'donor_id', 'donor_name', 'campaign', 'gift_date', 'amount'];

export function donorExportRow(row = {}) {
  const fullName = exportedDonorName(row);
  return {
    donor_id: row.id,
    donor_code: row.donor_code,
    first_name: row.first_name,
    last_name: row.last_name,
    preferred_name: row.preferred_name,
    full_name: fullName,
    household_name: row.household_name,
    email: row.email,
    home_phone: row.home_phone,
    mobile_phone: row.mobile_phone,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    country: row.country,
    assigned_officer: row.assigned_officer,
    stage: row.stage,
    lifetime_giving: row.lifetime_giving,
    last_gift_amount: row.last_gift_amount,
    last_gift_date: row.last_gift_date,
    last_contact_date: row.last_contact_date,
    next_action: row.next_action,
    next_action_date: row.next_action_date,
    is_archived: row.is_archived,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function giftExportRow(row = {}, donorsById = new Map()) {
  const donor = donorsById.get(row.donor_id) || {};
  return {
    gift_id: row.id,
    donor_id: row.donor_id,
    donor_name: exportedDonorName(donor),
    gift_date: row.gift_date,
    amount: row.amount,
    gift_type: row.gift_type,
    campaign: row.campaign,
    pledge_id: row.pledge_id,
    appeal: row.appeal,
    payment_method: row.payment_method,
    check_number: row.check_number,
    transaction_id: row.transaction_id,
    recognition_name: row.recognition_name,
    soft_credit_name: row.soft_credit_name,
    shared_credit_amount: row.shared_credit_amount,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function activityExportRow(row = {}, donorsById = new Map()) {
  const donor = donorsById.get(row.donor_id) || {};
  return {
    activity_id: row.id,
    donor_id: row.donor_id,
    donor_name: exportedDonorName(donor),
    activity_type: row.activity_type,
    occurred_at: row.occurred_at,
    subject: row.subject,
    summary: row.summary,
    next_action: row.next_action,
    next_action_date: row.next_action_date,
    next_action_completed_at: row.next_action_completed_at,
    is_archived: row.is_archived,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function createExportFile(datasets, format, metadata = {}) {
  const exportedAt = new Date().toISOString();
  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
      buffer: Buffer.from(JSON.stringify({
        export_version: '2.1',
        exported_at: exportedAt,
        ...metadata,
        data: Object.fromEntries(datasets.map(dataset => [dataset.key, dataset.rows]))
      }, null, 2))
    };
  }
  if (format === 'xlsx') {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
      buffer: await excelWorkbook(datasets)
    };
  }
  if (datasets.length === 1) {
    return {
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      buffer: Buffer.from(`\uFEFF${csvForRows(datasets[0].rows, datasets[0].columns)}`)
    };
  }
  const zip = new JSZip();
  datasets.forEach(dataset => zip.file(`${dataset.key}.csv`, `\uFEFF${csvForRows(dataset.rows, dataset.columns)}`));
  return {
    contentType: 'application/zip',
    extension: 'zip',
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  };
}
