import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken } from '../netlify/functions/_shared/auth.mjs';
import { handler as processDocument } from '../netlify/functions/process-document.mjs';
import { handler as knowledgeDocument } from '../netlify/functions/knowledge-document.mjs';
import { handler as importDonors } from '../netlify/functions/import-donors.mjs';

test('parses only Bearer authorization tokens', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc123' } }), '');
  assert.equal(bearerToken({}), '');
});

test('process-document rejects unsupported methods before authentication', async () => {
  const response = await processDocument({ httpMethod: 'GET', headers: {} });
  assert.equal(response.statusCode, 405);
});

test('critical document functions require authentication', async () => {
  const processResponse = await processDocument({ httpMethod: 'POST', headers: {}, body: '{}' });
  const deleteResponse = await knowledgeDocument({ httpMethod: 'DELETE', headers: {}, body: '{}' });
  assert.equal(processResponse.statusCode, 401);
  assert.equal(deleteResponse.statusCode, 401);
});

test('donor import rejects unsupported methods and unauthenticated writes', async () => {
  const methodResponse = await importDonors({ httpMethod: 'GET', headers: {} });
  const authResponse = await importDonors({ httpMethod: 'POST', headers: {}, body: '{"rows":[]}' });
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(authResponse.statusCode, 401);
});
