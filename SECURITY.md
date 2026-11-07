# Security

DarkLion stores sensitive taxpayer data. If you self-host it, you are the data custodian.

## Reporting a vulnerability

Please open a private security advisory on this GitHub repository (Security tab, "Report a vulnerability"). Do not open a public issue. There is no bounty and no guaranteed response time; the project is provided as is.

## Operator checklist

- Generate unique `JWT_SECRET` and `ENCRYPTION_KEY` values. Never reuse examples. Back up `ENCRYPTION_KEY` offline.
- Serve only over HTTPS. Keep `NODE_ENV=production`.
- Use a private storage bucket with public access blocked.
- Turn on database backups and point-in-time recovery.
- Keep `DARKLION_PUBLIC_ENROLLMENT=false` unless you intend to host other firms.
- Require strong passwords and remove staff accounts promptly when people leave.
- Keep dependencies updated (`npm audit`).
- Maintain a written information security plan (IRS Pub 4557 / FTC Safeguards Rule).
