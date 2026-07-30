export const MEDIA_PAGE_SIZE = 24;
export const MEDIA_MAX_BYTES = Object.freeze({
  document: 25 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024
});

const EXTENSION_KIND = Object.freeze({
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  txt: 'document',
  csv: 'document',
  xls: 'document',
  xlsx: 'document',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  heic: 'image',
  heif: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video'
});

function clean(value) {
  return String(value ?? '').trim();
}

export function mediaKindForFile(file = {}) {
  const mime = clean(file.type).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const extension = clean(file.name).toLowerCase().split('.').pop();
  return EXTENSION_KIND[extension] || null;
}

export function validateMediaFile(file = {}) {
  const kind = mediaKindForFile(file);
  if (!kind) throw new Error(`${file.name || 'This file'} is not a supported document, image, or video.`);
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${file.name || 'This file'} is empty.`);
  if (file.size > MEDIA_MAX_BYTES[kind]) {
    const limit = Math.round(MEDIA_MAX_BYTES[kind] / (1024 * 1024));
    throw new Error(`${file.name || 'This file'} must be ${limit} MB or smaller.`);
  }
  return kind;
}

export function normalizeMediaMetadata(input = {}, file = {}) {
  const kind = validateMediaFile(file);
  return {
    original_filename: clean(file.name),
    media_kind: kind,
    mime_type: clean(file.type) || 'application/octet-stream',
    file_size: file.size,
    title: clean(input.title) || clean(file.name).replace(/\.[^.]+$/, ''),
    description: clean(input.description) || null,
    tags: [...new Set(clean(input.tags).split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 20),
    related_donor_id: clean(input.related_donor_id) || null,
    related_campaign: clean(input.related_campaign) || null,
    related_activity_id: clean(input.related_activity_id) || null,
    processing_status: 'uploaded'
  };
}

export function filterMediaAssets(rows = [], {
  search = '',
  kind = '',
  campaign = '',
  donorId = '',
  sort = 'newest'
} = {}) {
  const query = clean(search).toLowerCase();
  const filtered = rows.filter(row => {
    if (row.is_deleted) return false;
    if (kind && row.media_kind !== kind) return false;
    if (campaign && clean(row.related_campaign).toLowerCase() !== clean(campaign).toLowerCase()) return false;
    if (donorId && row.related_donor_id !== donorId) return false;
    if (!query) return true;
    return [
      row.original_filename,
      row.title,
      row.description,
      ...(row.tags || [])
    ].some(value => clean(value).toLowerCase().includes(query));
  });
  return [...filtered].sort((left, right) => {
    const difference = Date.parse(right.uploaded_at) - Date.parse(left.uploaded_at);
    return sort === 'oldest' ? -difference : difference;
  });
}
