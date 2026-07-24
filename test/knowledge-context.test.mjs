import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeContext, rankKnowledgeDocuments, searchTerms } from '../netlify/functions/_shared/knowledge.mjs';

const rows = [
  { title: 'Annual Dinner', tags: ['event'], content: 'Dinner details and reservations.', favorite: true },
  { title: 'Scholarship Campaign', tags: ['scholarship'], content: 'A scholarship supports a talmid for one year.', favorite: false },
  { title: 'Building Update', tags: ['campus'], content: 'Construction update.', favorite: false }
];

test('normalizes useful search terms', () => {
  assert.deepEqual(searchTerms('Write about the SCHOLARSHIP scholarship campaign'), ['scholarship', 'campaign']);
});

test('ranks relevant knowledge ahead of an unrelated favorite', () => {
  assert.equal(rankKnowledgeDocuments(rows, 'scholarship for a talmid')[0].title, 'Scholarship Campaign');
});

test('builds bounded context with document headings', () => {
  const context = buildKnowledgeContext(rows, 'scholarship', { maxDocuments: 1, maxCharacters: 1000 });
  assert.match(context, /^## Scholarship Campaign/m);
  assert.doesNotMatch(context, /Annual Dinner/);
});
