# Self-hosting DarkLion

This is one tested recipe. Anything that runs Node 20 and Postgres works.

## What you need

| Piece | Suggested | Rough cost |
| --- | --- | --- |
| App host | Render web service (Docker) or Railway | $7 to $25 / month |
| Database | Neon or Render Postgres | free to $20 / month |
| File storage | Cloudflare R2 (two buckets) or AWS S3 | pennies per GB |
| Email | Resend, with your domain verified | free tier to $20 / month |
| AI (optional) | Anthropic API key | usage based, see ai-setup.md |

## Steps

1. **Fork or clone** this repo into your own GitHub account.
2. **Database.** Create a Postgres database and copy its connection string into `DATABASE_URL`. Tables are created automatically on first boot.
3. **Storage.** Create a private bucket for documents (and for R2, a second one for history). Create an API token limited to those buckets. Fill in the storage section of `.env.example`.
4. **Email.** Verify your sending domain in Resend and set `RESEND_API_KEY` and `RESEND_FROM`. For client email replies to land back in DarkLion, point an inbound domain at Resend and set `EMAIL_REPLY_DOMAIN` and `EMAIL_INBOUND_WEBHOOK_SECRET`.
5. **Secrets.** Generate `JWT_SECRET` and `ENCRYPTION_KEY` (commands are in `.env.example`).
6. **App host.** Create a web service from your repo using the included `Dockerfile`. Add every variable from your `.env` in the host's environment settings, never in the repo. Health check path: `/ready`.
7. **Domain.** Point `portal.yourfirm.com` at the host and set `APP_URL` to it.
8. **First login.** From a shell with the production env loaded (Render shell, or locally pointed at the production database), run `npm run bootstrap` with `FIRM_NAME`, `OWNER_NAME`, `OWNER_EMAIL`, `OWNER_PASSWORD`.
9. **Branding.** Sign in, open Settings, and upload your logo, colors, and contact details. These drive the client portal and emails.

## Custom client domains

Settings → Custom Domain shows the DNS records to add. The main app host set by `APP_URL` (and `ADMIN_HOSTNAME`) is reserved.

## Backups

Turn on your database provider's point-in-time recovery, enable bucket versioning, and keep an offline copy of `ENCRYPTION_KEY`. Without that key, SSNs and stored tokens cannot be decrypted.

## Updating

Pull from this repository into your fork and redeploy. Schema changes run automatically and are additive.
