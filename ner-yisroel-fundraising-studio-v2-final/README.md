# Ner Yisroel Fundraising Studio V2

This package contains a real Netlify + Supabase application with:

- Email/password authentication
- Row Level Security for each user's data
- Permanent knowledge documents
- Google Drive read-only OAuth and file import
- Donor profiles
- AI letter review and communication generators
- Saved generation history and favorites
- PDF, Word, RTF, Markdown, and text uploads

## Architecture

- **Frontend:** static HTML/CSS/JavaScript hosted by Netlify
- **Authentication and database:** Supabase Auth + Postgres
- **Server functions:** Netlify Functions
- **AI:** OpenAI Responses API
- **Drive:** Google OAuth 2.0 web-server flow with read-only Drive scope

## Step 1: Create the Supabase project

1. Create a project at Supabase.
2. In the left sidebar, open **SQL Editor**.
3. Click **New query**.
4. Open `supabase/schema.sql` from this package.
5. Copy the entire file into the query editor.
6. Click **Run**.

The script creates the tables, indexes, triggers, grants, and Row Level Security policies.

## Step 2: Get the Supabase values

In Supabase, open **Project Settings > API** and copy:

- Project URL → `SUPABASE_URL`
- anon or publishable key → `SUPABASE_ANON_KEY`
- service_role key → `SUPABASE_SERVICE_ROLE_KEY`

Never expose the service-role key in browser code or GitHub.

### Authentication settings

In Supabase, open **Authentication > URL Configuration**:

- Set **Site URL** to your final Netlify URL.
- Add the same Netlify URL under **Redirect URLs**.

In **Authentication > Providers > Email**, choose whether email confirmation is required. During initial testing, disabling confirmation is simpler. For production, confirmation is safer.

## Step 3: Put the project in a private GitHub repository

Netlify needs to run `npm install` and the build command, so use a Git-connected deployment.

1. Unzip this package.
2. Create a new private GitHub repository.
3. Upload every file and folder from the unzipped project.
4. Commit the files.

Do not add a real `.env` file to GitHub.

## Step 4: Import the GitHub repository into Netlify

1. In Netlify, choose **Add new project > Import an existing project**.
2. Select GitHub and the private repository.
3. Netlify should read `netlify.toml` automatically.
4. Confirm:
   - Build command: `npm run build`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`

## Step 5: Add Netlify environment variables

Add each name and value in separate fields:

```text
OPENAI_API_KEY
OPENAI_MODEL
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
APP_URL
```

Recommended value:

```text
OPENAI_MODEL = gpt-5-mini
```

`APP_URL` is your exact Netlify address, for example:

```text
https://your-site-name.netlify.app
```

`GOOGLE_REDIRECT_URI` must be:

```text
https://your-site-name.netlify.app/api/google-callback
```

All secret variables should have Functions scope or All scopes. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are also used during the build to generate `public/runtime-config.js`.

After adding variables, trigger a new deploy.

## Step 6: Configure Google Drive

1. Create or select a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the OAuth consent screen.
4. During testing, add your Google account as a test user.
5. Create an OAuth client with application type **Web application**.
6. Add the exact authorized redirect URI:

```text
https://your-site-name.netlify.app/api/google/callback
```

7. Put the Client ID and Client Secret into Netlify as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
8. Redeploy.

The app requests read-only Drive access. Google credentials are stored in the server-only `google_connections` table, which has no browser access policy.

## Updating the app

Edit or replace files in the GitHub repository and commit. Netlify redeploys automatically.

## Security notes

- Supabase Row Level Security restricts knowledge, donors, and history to the signed-in user.
- The Supabase service-role key and Google client secret are only used in Netlify Functions.
- Google refresh tokens are accessible to database administrators and server functions. Do not expose the `google_connections` table through a browser policy.
- The app uses read-only Google Drive access.
- Uploaded documents are temporarily sent to OpenAI and deleted after processing when possible.
- This is a functional foundation, not a compliance-certified CRM. Do not store highly sensitive financial or personal data without a formal security review.
