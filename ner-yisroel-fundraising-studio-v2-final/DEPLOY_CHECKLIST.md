# Deployment checklist

- [ ] Run `supabase/schema.sql` in Supabase SQL Editor
- [ ] Set Supabase Site URL and Redirect URL to the Netlify address
- [ ] Put this project in a private GitHub repository
- [ ] Import the repository into Netlify
- [ ] Add all variables listed in `.env.example`
- [ ] Set `APP_URL` to the exact Netlify URL
- [ ] Set `GOOGLE_REDIRECT_URI` to `https://YOUR-SITE.netlify.app/api/google-callback`
- [ ] Enable Google Drive API
- [ ] Add the same callback URL to the Google OAuth Web Client
- [ ] Add your Google account as a test user while the OAuth app is in testing
- [ ] Trigger a new Netlify deploy
- [ ] Create a user account in the app
- [ ] Test knowledge creation, AI generation, donor creation, and Drive import
