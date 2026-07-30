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

function worksheetXml(rows = []) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
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
  sheets.forEach(sheet => worksheetFolder.file(`sheet${sheet.sheetId}.xml`, worksheetXml(sheet.rows)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
