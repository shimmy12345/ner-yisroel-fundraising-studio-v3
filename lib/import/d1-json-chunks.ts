const encoder = new TextEncoder();

export const D1_JSON_CHUNK_BYTES = 512_000;

/**
 * Serializes rows into JSON arrays that remain comfortably below D1's 2 MB
 * maximum bound string size. The returned strings can be passed to json_each(?).
 */
export function chunkJsonRows<T>(rows: T[], maxBytes = D1_JSON_CHUNK_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error("Invalid D1 JSON chunk size");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 2;

  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowBytes = encoder.encode(serialized).byteLength;
    if (rowBytes + 2 > maxBytes) throw new Error("A single validated donation row exceeds the D1 binding limit");
    const nextBytes = currentBytes + rowBytes + (current.length ? 1 : 0);
    if (current.length && nextBytes > maxBytes) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      currentBytes = 2;
    }
    current.push(serialized);
    currentBytes += rowBytes + (current.length > 1 ? 1 : 0);
  }
  if (current.length) chunks.push(`[${current.join(",")}]`);
  return chunks;
}
