import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  cleanExtractedText,
  extractDocumentText,
  validateDocumentRequest
} from '../netlify/functions/_shared/document-processing.mjs';

const userId = '11111111-1111-1111-1111-111111111111';
const baseRequest = {
  fileName: 'campaign.txt',
  mimeType: 'text/plain',
  fileSize: 12,
  storagePath: `${userId}/22222222-2222-2222-2222-222222222222/campaign.txt`,
  userId
};

test('validates an owned TXT upload', () => {
  assert.deepEqual(validateDocumentRequest(baseRequest), { ext: 'txt', normalizedMime: 'text/plain' });
});

test('rejects unsupported extensions, mismatched MIME types, and another user path', () => {
  assert.throws(() => validateDocumentRequest({ ...baseRequest, fileName: 'campaign.exe' }), { status: 415 });
  assert.throws(() => validateDocumentRequest({ ...baseRequest, mimeType: 'application/pdf' }), { status: 415 });
  assert.throws(() => validateDocumentRequest({ ...baseRequest, storagePath: `another-user/id/campaign.txt` }), { status: 403 });
});

test('cleans and extracts TXT and CSV without sending content to another service', async () => {
  assert.equal(cleanExtractedText('\uFEFFfirst\r\nsecond\u0000'), 'first\nsecond');
  const txt = await extractDocumentText(Buffer.from('Campaign notes'), 'txt');
  const csv = await extractDocumentText(Buffer.from('Name,Gift\r\nA,100'), 'csv');
  assert.equal(txt.content, 'Campaign notes');
  assert.equal(csv.content, 'Name,Gift\nA,100');
  assert.equal(csv.truncated, false);
});

test('routes valid PDF and DOCX buffers to their deterministic parsers', async () => {
  let pdfCalled = false;
  let docxCalled = false;
  const pdf = await extractDocumentText(Buffer.from('%PDF-test'), 'pdf', {
    pdf: async () => { pdfCalled = true; return 'PDF text'; }
  });
  const docx = await extractDocumentText(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'docx', {
    docx: async () => { docxCalled = true; return 'DOCX text'; }
  });
  assert.equal(pdf.content, 'PDF text');
  assert.equal(docx.content, 'DOCX text');
  assert.equal(pdfCalled, true);
  assert.equal(docxCalled, true);
});

test('rejects spoofed PDF and DOCX files', async () => {
  await assert.rejects(extractDocumentText(Buffer.from('not a pdf'), 'pdf'), { status: 415 });
  await assert.rejects(extractDocumentText(Buffer.from('not a zip'), 'docx'), { status: 415 });
});

function minimalPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 38} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function minimalDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('extracts text with the production PDF and DOCX parsers', async () => {
  const pdf = await extractDocumentText(minimalPdf('Scholarship PDF'), 'pdf');
  const docx = await extractDocumentText(await minimalDocx('Scholarship DOCX'), 'docx');
  assert.match(pdf.content, /Scholarship PDF/);
  assert.match(docx.content, /Scholarship DOCX/);
});
