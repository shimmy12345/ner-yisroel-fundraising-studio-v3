const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'for', 'from', 'have', 'into', 'our', 'that', 'the', 'their', 'this', 'with', 'write']);

export function searchTerms(value = '') {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [])]
    .filter(term => !STOP_WORDS.has(term))
    .slice(0, 40);
}

function countMatches(haystack, term) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(term, index)) !== -1 && count < 10) {
    count += 1;
    index += term.length;
  }
  return count;
}

export function rankKnowledgeDocuments(rows = [], query = '') {
  const terms = searchTerms(query);
  return rows.map((row, index) => {
    const title = String(row.title || '').toLowerCase();
    const tags = (row.tags || []).join(' ').toLowerCase();
    const content = String(row.content || '').toLowerCase();
    const relevance = terms.reduce((score, term) => score
      + countMatches(title, term) * 8
      + countMatches(tags, term) * 5
      + countMatches(content, term), 0);
    return { row, index, score: relevance + (row.favorite ? 3 : 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.row);
}

export function buildKnowledgeContext(rows, query, { maxDocuments = 20, maxCharacters = 80_000 } = {}) {
  const sections = [];
  let used = 0;
  for (const row of rankKnowledgeDocuments(rows, query).slice(0, maxDocuments)) {
    const heading = `## ${row.title || 'Untitled document'}\n`;
    const remaining = maxCharacters - used - heading.length;
    if (remaining <= 0) break;
    const content = String(row.content || '').slice(0, remaining);
    if (!content) continue;
    sections.push(`${heading}${content}`);
    used += heading.length + content.length + 2;
  }
  return sections.join('\n\n');
}
