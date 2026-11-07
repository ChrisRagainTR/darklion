# Client email replies

Optional. With this set up, a client can hit Reply on a DarkLion email and the reply lands in the right conversation in DarkLion. Without it, clients reply in the portal.

Resend only sends mail. Receiving replies needs a second piece: Mailgun inbound routes, or a Cloudflare Email Worker.

## How it works

Outgoing emails use a reply address like `reply+<token>@reply.yourfirm.com`. Your inbound provider receives mail for that subdomain and posts it to:

```text
POST https://portal.yourfirm.com/api/email-replies/inbound
```

## Settings

```bash
EMAIL_REPLY_DOMAIN=reply.yourfirm.com
EMAIL_INBOUND_WEBHOOK_SECRET=<long random secret>   # openssl rand -hex 32
```

The provider proves itself with the secret in any one of these:

- header `x-darklion-email-secret: <secret>`
- header `Authorization: Bearer <secret>`
- query string `?secret=<secret>` (handy for Mailgun)

## Option A: Mailgun

1. In Mailgun, add the domain `reply.yourfirm.com`.
2. At your DNS host, add the MX and TXT records Mailgun shows for that subdomain. On Cloudflare, keep them DNS-only (grey cloud).
3. Create a route: match recipient `.*@reply.yourfirm.com`, action Forward to `https://portal.yourfirm.com/api/email-replies/inbound?secret=<secret>`.

DarkLion reads Mailgun's payload as-is, attachments included. No adapter is needed.

## Option B: Cloudflare Email Worker

If your DNS is on Cloudflare, turn on Email Routing for `reply.yourfirm.com`, send all addresses to a Worker, and store the secret as a Worker secret named `DARKLION_INBOUND_SECRET`. A minimal Worker:

```js
import PostalMime from 'postal-mime';

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(s);
}

export default {
  async email(message, env) {
    const mail = await new PostalMime().parse(message.raw);
    const res = await fetch('https://portal.yourfirm.com/api/email-replies/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-darklion-email-secret': env.DARKLION_INBOUND_SECRET },
      body: JSON.stringify({
        to: message.to,
        from: mail.from?.address ? (mail.from.name || '') + ' <' + mail.from.address + '>' : message.from,
        subject: mail.subject || '',
        text: mail.text || '',
        html: mail.html || '',
        messageId: mail.messageId || '',
        headers: Object.fromEntries((mail.headers || []).map((h) => [h.key, h.value])),
        attachments: (mail.attachments || []).map((a) => ({
          filename: a.filename || 'attachment',
          contentType: a.mimeType || 'application/octet-stream',
          content: toBase64(new Uint8Array(a.content)),
        })),
      }),
    });
    if (!res.ok) throw new Error('DarkLion inbound failed: ' + res.status);
  },
};
```

Any other provider works too if it can POST this JSON shape: `to`, `from`, `subject`, `text`, `html`, `messageId`, `headers`, and `attachments` (base64 `content`).

## Safety rules built in

- A reply to a tokenized address is only accepted from the client or spouse that token belongs to.
- A message to the general `reply@` address must pass SPF, DKIM, or DMARC before it can start a new conversation.
- Unknown senders are rejected, and duplicate deliveries are ignored.
