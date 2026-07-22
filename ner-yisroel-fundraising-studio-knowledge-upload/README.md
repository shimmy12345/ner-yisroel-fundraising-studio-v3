# Ner Yisroel Fundraising Studio

Private fundraising communications workspace using Netlify, Supabase, and OpenAI.

## Knowledge Base upload upgrade

This version adds direct multi-file uploads, private Supabase Storage, text extraction, tags, favorites, duplicate detection, search, preview, and deletion.

### Required one-time database migration

After deploying this version, open Supabase **SQL Editor**, create a new query, paste the contents of:

`supabase/knowledge_upload_migration.sql`

Then click **Run**. This creates the private `knowledge-files` bucket and adds upload-related columns and policies.

### Supported uploads

PDF, DOC/DOCX, TXT, Markdown, CSV, JSON, HTML, RTF, XLS/XLSX, PPT/PPTX. Maximum size: 25 MB per file.

Text-like formats are decoded directly. Office documents and PDFs use the configured OpenAI model for text extraction.

### Netlify variables

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (recommended: `gpt-5-mini`)

### Deploy

Commit all files to GitHub. Netlify will build and deploy automatically. The project settings are defined in `netlify.toml`.
