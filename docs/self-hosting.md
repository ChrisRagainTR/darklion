# Self-hosting DarkLion

This is one tested recipe. Anything that runs Node 20 and Postgres works.

## Software you need

| Software | Required? | Notes |
| --- | --- | --- |
| Node.js 20 or newer | Required | Runs the app. |
| PostgreSQL 15 or newer | Required | Tables are created automatically on first boot. |
| S3-compatible storage (Cloudflare R2 or AWS S3) | Required | Holds client documents. |
| Chromium | Required for PDFs | Used to build PDFs (engagement letters, invoices, reports). The included `Dockerfile` installs it. Outside Docker, install Chromium and set `PUPPETEER_EXECUTABLE_PATH` to it. |
| Docker | Recommended | The easiest way to get Node and Chromium together. |
| ClamAV | Optional | Virus scans uploads when `CLAMAV_HOST` is set. |

## Outside services

| Service | Required? | What it does | What happens without it |
| --- | --- | --- | --- |
| Resend | Strongly recommended | Sends all outgoing email: client invites, password resets, signature requests, message notifications. | The app runs, but no email goes out. Emails are logged and skipped. |
| Pusher | Optional | Live updates, so new messages appear instantly. | Pages check for new messages every few seconds instead. Everything still works. |
| Mailgun or a Cloudflare Email Worker | Optional | Lets clients reply to an email and have the reply land in DarkLion. See [email-replies.md](email-replies.md). | Clients reply in the portal instead. |
| Anthropic | Optional | AI features. See [ai-setup.md](ai-setup.md). | AI features are hidden or disabled. |
| Twilio | Optional | Text messages. | No SMS. |
| QuickBooks Online | Optional | Bookkeeping sync. | No QuickBooks sync. |
| Stripe | Optional | Client invoices and payments. | No card payments. |

## Suggested hosting

| Piece | Suggested | Rough cost |
| --- | --- | --- |
| App host | Render web service (Docker) or Railway | $7 to $25 / month |
| Database | Neon or Render Postgres | free to $20 / month |
| File storage | Cloudflare R2 (two buckets) or AWS S3 | pennies per GB |
| Email | Resend, with your domain verified | free tier to $20 / month |
| Live updates (optional) | Pusher Channels | free tier covers a small firm |
| AI (optional) | Anthropic API key | usage based, see ai-setup.md |

## Steps

1. **Fork or clone** this repo into your own GitHub account.
2. **Database.** Create a Postgres database and copy its connection string into `DATABASE_URL`.
3. **Storage.** Create a private bucket for documents (and for R2, a second one for history). Create an API token limited to those buckets. Fill in the storage section of `.env.example`.
4. **Email (Resend).** Sign up at resend.com, add your domain, and add the DNS records Resend shows you until the domain says Verified. Create an API key and set `RESEND_API_KEY`. Set `RESEND_FROM` to an address on that domain, for example `Your Firm <messages@yourfirm.com>`.
5. **Live updates (Pusher, optional).** Sign up at pusher.com and create a Channels app. From its App Keys page, set `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, and `PUSHER_CLUSTER` (for example `us2`). Skip this and the app falls back to checking every few seconds.
6. **Email replies (optional).** Follow [email-replies.md](email-replies.md).
7. **Secrets.** Generate `JWT_SECRET` and `ENCRYPTION_KEY` (commands are in `.env.example`).
8. **App host.** Create a web service from your repo using the included `Dockerfile`. Add every variable from your `.env` in the host's environment settings, never in the repo. Health check path: `/ready`.
9. **Domain.** Point `portal.yourfirm.com` at the host and set `APP_URL` to it.
10. **First login.** From a shell with the production env loaded (Render shell, or locally pointed at the production database), run `npm run bootstrap` with `FIRM_NAME`, `OWNER_NAME`, `OWNER_EMAIL`, `OWNER_PASSWORD`.
11. **Branding.** Sign in, open Settings, and upload your logo, colors, and contact details. These drive the client portal and emails.

## Communication archive (optional)

DarkLion can keep a write-once copy of every client message in a separate bucket for record-keeping rules. Set the `COMMUNICATION_ARCHIVE_*` variables in `.env.example` to turn it on. When an archive bucket is set, messages are refused if the archive write fails. Set `COMMUNICATION_ARCHIVE_FAIL_CLOSED=false` to send anyway, or `true` to require the archive. With no archive bucket, messages send normally.

## Custom client domains

Settings → Custom Domain shows the DNS records to add. The main app host set by `APP_URL` (and `ADMIN_HOSTNAME`) is reserved.

## Backups

Turn on your database provider's point-in-time recovery, enable bucket versioning, and keep an offline copy of `ENCRYPTION_KEY`. Without that key, SSNs and stored tokens cannot be decrypted.

## Updating

Pull from this repository into your fork and redeploy. Schema changes run automatically and are additive.
