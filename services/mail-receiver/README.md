# mail-receiver

Minimal SMTP server that accepts inbound mail addressed to the
storefront domain and forwards each message to the api's
`/webhooks/sendgrid-inbound/<secret>` endpoint, shaped exactly like a
SendGrid Inbound Parse POST. The api-side webhook handler is unchanged
— mail-receiver is the on-prem replacement for SendGrid's inbound
service.

## Why self-hosted

Twilio (SendGrid's parent) declined the operator's account at signup
citing "regional service requirements" — common for accounts based in
sanction-adjacent regions or in regulated industries. Self-hosting on
the Hetzner box gives us a region-neutral, industry-neutral inbound
path that no third party can revoke.

Outbound mail still goes through Resend (verify, password reset,
admin compose, replies) — this service never sends.

## How it works

1. Listens on `:2525` inside the container. Docker compose maps
   host port `25 → 2525` so external SMTP servers reach us at the
   default mail port without the container needing `NET_BIND_SERVICE`.
2. Accepts any sender (real-world SMTP doesn't authenticate inbound)
   but only RCPTs in `MAIL_RECEIVER_DOMAIN` — rejects everything else
   with a 550 so we're not an open relay.
3. For each `DATA`, reads the raw RFC 5322 message, parses headers +
   body (multipart-aware, handles quoted-printable + base64), and
   POSTs as `multipart/form-data` to `MAIL_WEBHOOK_URL/<secret>` with
   field names that match SendGrid's Inbound Parse spec.
4. On webhook 5xx or network failure, returns SMTP `451` so the
   sending server retries on its own cadence (typically every 5-30
   min for 24-48 hours).

## Env vars

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MAIL_WEBHOOK_URL` | yes | — | URL of the api's inbound webhook (without the secret path component) — e.g. `http://api:3001/webhooks/sendgrid-inbound` |
| `SENDGRID_INBOUND_SECRET` | yes | — | The same secret the api's webhook expects in its path. Generate with `openssl rand -hex 24`. |
| `MAIL_RECEIVER_DOMAIN` | no | `oddzilla.cc` | Domain that RCPT addresses must match |
| `MAIL_RECEIVER_LISTEN` | no | `:2525` | Listen address |

## DNS required

For external mail to reach us:

```
mail.oddzilla.cc.    A    178.104.174.24
oddzilla.cc.        MX 10 mail.oddzilla.cc.
```

The `mail.oddzilla.cc` A record points at the Hetzner box; the MX
record sends inbound mail there. Outbound DNS (Resend's DKIM + SPF)
is independent — MX governs inbound only.

## Limits + future work

- **No STARTTLS.** Most senders deliver plain-text to MX records that
  don't advertise STARTTLS, but stricter servers will downgrade-reject.
  To enable: mount Caddy's Let's Encrypt cert volume (`caddy-data`),
  read `mail.oddzilla.cc.crt` + `.key`, configure `srv.TLSConfig` in
  `main.go`.
- **No spam filtering.** At MVP volume (handful of emails per week)
  the operator can delete junk from the admin inbox. To enable:
  pipe each accepted message through `rspamd` before the relay POST
  (sidecar container, listens on :11333), reject ≥ score threshold.
- **No outbound.** This service is inbound-only by design. Outbound
  is Resend's job.
- **No queue.** If the api is down we return 451 and rely on the
  sender to retry. For MVP this is fine; senders retry for 24-48h.
  Future: drop accepted messages into a SQLite spool on a `/spool`
  volume and drain to the webhook in the background.

## Local development

```sh
SENDGRID_INBOUND_SECRET=$(openssl rand -hex 24) \
MAIL_WEBHOOK_URL=http://localhost:3001/webhooks/sendgrid-inbound \
MAIL_RECEIVER_LISTEN=:2525 \
MAIL_RECEIVER_DOMAIN=localhost \
go run ./cmd/mail-receiver
```

Send a test message with `swaks`:
```sh
swaks --to test@localhost --from sender@example.com \
      --server localhost:2525 \
      --body 'hello from swaks'
```
