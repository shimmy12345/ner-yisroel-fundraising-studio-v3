# Install the Knowledge Base Upload Upgrade

## 1. Run the Supabase migration

1. Open your Supabase project.
2. Select **SQL Editor**.
3. Select **New query**.
4. Open `supabase/knowledge_upload_migration.sql` from this project.
5. Copy the entire file into the query editor.
6. Select **Run**.

This does not delete your existing data. It adds upload fields, creates a private Storage bucket named `knowledge-files`, and creates per-user access policies.

## 2. Update GitHub

Upload all files from this project into the existing GitHub repository, replacing files with the same names. Commit the changes to `main`.

Netlify should automatically start a new deployment.

## 3. Verify Netlify

Confirm the deploy is published. The new server function should appear as:

`process-document`

No new environment variables are required beyond the Supabase and OpenAI variables already configured.

## 4. Test

1. Sign in.
2. Open **Knowledge Base**.
3. Upload a small TXT or CSV file first.
4. Confirm it appears in the document list.
5. Upload a PDF or DOCX and allow extra time for text extraction.
6. Open **AI Studio** and ask a question whose answer appears in the uploaded document.
