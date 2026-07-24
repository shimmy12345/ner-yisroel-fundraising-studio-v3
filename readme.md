# Ner Yisroel Fundraising Studio

Private fundraising communications workspace deployed as a static Netlify site with Netlify Functions, Supabase Auth/Postgres/Storage, and the OpenAI Responses API.

## Verified architecture

- `public/`: browser application. It receives only `SUPABASE_URL` and `SUPABASE_ANON_KEY` through generated `public/runtime-config.js`.
- `netlify/functions/`: authenticated server endpoints for AI generation, document extraction, signed original-file links, and deletion.
- `supabase/schema.sql`: complete schema for a new Supabase project.
- `supabase/migrations/20260722_knowledge_base_uploads.sql`: idempotent upgrade for an existing deployment.
- `build.mjs`: writes the public Supabase URL and anon/publishable key at build time.
- `netlify.toml`: publishes `public`, bundles functions with esbuild, and maps `/api/*` to `/.netlify/functions/:splat`.

The browser uploads directly to the private `knowledge-files` bucket using the signed-in user's access token. Storage policies require the first path segment to equal `auth.uid()`. Netlify Functions create a user-scoped Supabase client from the same token, so document rows and objects remain subject to Row Level Security. A service-role key is not used or required.

## Knowledge Base uploads

- Drag and drop or choose multiple files.
- Supported formats: TXT, CSV, PDF, and DOCX.
- Maximum size: 25 MB per file.
- Real byte progress is shown while uploading to Supabase Storage; extraction status follows the upload.
- TXT and CSV are decoded locally in the function. PDF uses `unpdf`'s serverless PDF.js build, loaded only for PDF requests; DOCX uses `mammoth`. Uploaded content is not sent to OpenAI for extraction.
- Extracted text, metadata, tags, checksum, favorite state, and the private Storage path are saved in `knowledge_documents`.
- Search covers titles, tags, and extracted text. Preview displays extracted text and offers a five-minute signed download link for the original.
- AI generation relevance-ranks the signed-in user's Knowledge Base and includes up to 20 documents/80,000 characters as context.

Extracted text is capped at 2,000,000 characters per document; the original character count and truncation flag are recorded in `metadata`.

Google Drive integration is intentionally not included. A migration does not delete any legacy Google tables or rows; they can be removed separately after confirming they are no longer needed.

## Local setup

Requirements: Node.js 22 and npm.

```text
npm install
npm test
npm run build
```

For a local build, set:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
```

Never put `SUPABASE_SERVICE_ROLE_KEY` or `OPENAI_API_KEY` in `public/`, `runtime-config.js`, or client-side code.

## Supabase migration

For an existing project:

1. Open Supabase Dashboard → **SQL Editor** → **New query**.
2. Copy the complete contents of `supabase/migrations/20260722_knowledge_base_uploads.sql`.
3. Run the query once. It is safe to rerun.
4. Open **Storage** and verify `knowledge-files` exists and is marked private.
5. In **Database → Policies**, verify `knowledge_documents` has `knowledge own rows` and `storage.objects` has the three `knowledge files ... own folder` policies.

For a brand-new project, run `supabase/schema.sql` instead. Do not run both scripts on a fresh project.

The migration:

- adds upload metadata, tags, favorite, checksum, and extraction-status columns;
- creates a per-user checksum index;
- creates/updates the private 25 MB `knowledge-files` bucket with the four supported MIME groups; and
- recreates authenticated row and Storage policies based on `auth.uid()`.

## Netlify deployment

1. In Netlify, import `shimmy12345/ner-yisroel-fundraising-studio` and select `feature/knowledge-base-uploads` for review deploys.
2. Clear any previous nested **Base directory** setting. The base directory must be the repository root.
3. Netlify reads `netlify.toml`; verify:
   - Build command: `npm run build`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Node version: `22`
4. Add these environment variables:
   - `SUPABASE_URL` — scopes: Builds and Functions
   - `SUPABASE_ANON_KEY` — scopes: Builds and Functions
   - `OPENAI_API_KEY` — scope: Functions only
   - `OPENAI_MODEL` — optional, Functions only; defaults to `gpt-5-mini`
5. Do **not** add `SUPABASE_SERVICE_ROLE_KEY`; this app deliberately uses the authenticated user's RLS-scoped client.
6. Trigger a deploy after running the Supabase migration.

Expected function routes:

| Browser route | Netlify Function |
| --- | --- |
| `POST /api/generate` | `netlify/functions/generate.mjs` |
| `POST /api/process-document` | `netlify/functions/process-document.mjs` |
| `GET /api/knowledge-document?id=...` | `netlify/functions/knowledge-document.mjs` |
| `DELETE /api/knowledge-document` | `netlify/functions/knowledge-document.mjs` |

## Post-deploy verification

1. Sign in as user A and upload one TXT, CSV, PDF, and DOCX file together.
2. Confirm each upload shows byte progress, then `Extracting text`, then `Ready`.
3. Search for text that exists only inside an uploaded document and preview it.
4. Favorite a document, refresh, and confirm the favorite persists.
5. Generate copy using a fact unique to an uploaded document and verify the response uses that fact without inventing details.
6. Delete an uploaded document and confirm both its row and Storage object disappear.
7. Sign in as user B and confirm user A's rows, previews, signed links, and Storage objects are inaccessible.

## Security notes

- Supabase anon/publishable keys are designed for browser use; RLS is the security boundary.
- The service-role key is absent from the application and browser bundle.
- Original files remain private. Download links are signed for five minutes and only created after an authenticated, RLS-protected lookup.
- OpenAI receives the selected Knowledge Base text only when the user runs generation. PDF/DOCX extraction is local to the Netlify Function.
- This is not a compliance-certified CRM; perform a formal security review before storing highly sensitive financial or personal data.
