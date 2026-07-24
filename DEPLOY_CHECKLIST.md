# Deployment checklist

- [ ] Run `supabase/migrations/20260722_knowledge_base_uploads.sql` for an existing database, or `supabase/schema.sql` for a new database.
- [ ] Confirm `knowledge-files` is private and limited to 25 MB.
- [ ] Confirm `knowledge_documents` and `storage.objects` ownership policies are enabled.
- [ ] Clear any old nested Netlify base directory; deploy from the repository root.
- [ ] Confirm Netlify uses `npm run build`, `public`, and `netlify/functions`.
- [ ] Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to Builds and Functions.
- [ ] Add `OPENAI_API_KEY` and optional `OPENAI_MODEL` to Functions only.
- [ ] Confirm no `SUPABASE_SERVICE_ROLE_KEY` is configured or present in browser assets.
- [ ] Run `npm test` and `npm run build`.
- [ ] Test TXT, CSV, PDF, and DOCX uploads with two different user accounts.
- [ ] Test search, preview, favorite, original download, delete, and AI Knowledge Base context.
