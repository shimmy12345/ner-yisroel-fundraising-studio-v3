import mammoth from 'mammoth';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 2_000_000;

const MIME_TYPES = {
  txt: new Set(['', 'application/octet-stream', 'text/plain']),
  csv: new Set(['', 'application/octet-stream', 'text/csv', 'application/csv', 'application/vnd.ms-excel']),
  pdf: new Set(['', 'application/octet-stream', 'application/pdf']),
  docx: new Set(['', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
};

export function extension(fileName = '') {
  const match = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function validateDocumentRequest({ fileName, mimeType = '', fileSize, storagePath, userId }) {
  if (!fileName || !storagePath) throw httpError(400, 'File information is missing.');
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw httpError(400, 'The file is empty or its size is invalid.');
  if (fileSize > MAX_FILE_BYTES) throw httpError(413, 'Files must be 25 MB or smaller.');

  const ext = extension(fileName);
  if (!MIME_TYPES[ext]) throw httpError(415, 'Only TXT, CSV, PDF, and DOCX files are supported.');
  const normalizedMime = String(mimeType).toLowerCase().split(';', 1)[0].trim();
  if (!MIME_TYPES[ext].has(normalizedMime)) {
    throw httpError(415, `The file type reported for ${fileName} does not match .${ext}.`);
  }

  const segments = String(storagePath).split('/');
  if (segments.length < 3 || segments[0] !== userId || segments.some(part => !part || part === '.' || part === '..')) {
    throw httpError(403, 'Invalid storage path.');
  }
  return { ext, normalizedMime };
}

export function cleanExtractedText(value = '') {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function assertFileSignature(buffer, ext) {
  if (ext === 'pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw httpError(415, 'The selected file is not a valid PDF.');
  }
  if (ext === 'docx' && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw httpError(415, 'The selected file is not a valid DOCX document.');
  }
}

async function extractPdf(buffer) {
  // Keep the PDF runtime out of the function's startup path. unpdf ships a
  // serverless PDF.js build that does not require browser DOM globals such as
  // DOMMatrix, while TXT, CSV, and DOCX requests never load it at all.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const document = await getDocumentProxy(data);
  try {
    const result = await extractText(document, { mergePages: true });
    return result.text || '';
  } finally {
    await document.destroy();
  }
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

export async function extractDocumentText(buffer, ext, parsers = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'The uploaded file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw httpError(413, 'Files must be 25 MB or smaller.');
  assertFileSignature(buffer, ext);

  let raw;
  if (ext === 'txt' || ext === 'csv') raw = buffer.toString('utf8');
  else if (ext === 'pdf') raw = await (parsers.pdf || extractPdf)(buffer);
  else if (ext === 'docx') raw = await (parsers.docx || extractDocx)(buffer);
  else throw httpError(415, 'Only TXT, CSV, PDF, and DOCX files are supported.');

  const cleaned = cleanExtractedText(raw);
  if (!cleaned) throw httpError(422, 'No readable text could be extracted from this file.');
  return {
    content: cleaned.slice(0, MAX_EXTRACTED_CHARACTERS),
    truncated: cleaned.length > MAX_EXTRACTED_CHARACTERS,
    originalCharacterCount: cleaned.length
  };
}
