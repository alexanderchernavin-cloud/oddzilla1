// Template rendering. Two kinds today: verify_email, password_reset.
// Each template receives a typed payload and returns subject + html +
// text — text is the deliverability + accessibility fallback for clients
// that don't render HTML.
//
// Why hand-written HTML rather than a templating library: the surface is
// tiny (two emails), every mail client supports a different subset of
// CSS, and inline-styled tables are the only thing that renders
// consistently. Pulling in MJML / react-email for two emails is more
// bytes shipped + more deps to update than benefit.
//
// Hard rule per CLAUDE.md: no emojis in user-facing copy. Tone is the
// same quiet-editorial register the storefront uses.

export interface VerifyEmailPayload {
  /** The fully-qualified link the user clicks to verify. */
  url: string;
  /** Display name fallback for the salutation. May be null. */
  displayName: string | null;
}

export interface PasswordResetPayload {
  url: string;
  displayName: string | null;
  /** Expiry in human-readable form, e.g. "30 minutes". */
  expiresIn: string;
  /** Best-effort IP that requested the reset. May be null. */
  requestedIp: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = "Oddzilla";

// Inline style fragments shared across templates. Mail clients require
// inline styles; <style> blocks are stripped by Gmail / Outlook web.
const S = {
  body:
    "margin:0;padding:0;background:#f4f2ec;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1a1a1a;",
  container: "max-width:560px;margin:0 auto;padding:32px 24px;",
  heading: "font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.2;margin:0 0 16px 0;font-weight:400;",
  paragraph: "font-size:15px;line-height:1.55;margin:0 0 16px 0;",
  cta:
    "display:inline-block;background:#1a1a1a;color:#f4f2ec;padding:12px 20px;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:0.02em;",
  fineprint:
    "font-size:12px;line-height:1.5;color:#6a6a6a;margin:24px 0 0 0;border-top:1px solid #e4e1d8;padding-top:16px;",
  link: "color:#1a1a1a;",
};

function salutation(displayName: string | null): string {
  return displayName && displayName.trim().length > 0 ? `Hi ${escapeHtml(displayName)},` : "Hi,";
}

// Minimal HTML escape for the only user-controlled field embedded into
// HTML: display name. URLs are constructed from server-side env + a
// base64url token so they're always safe.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderVerifyEmail(p: VerifyEmailPayload): RenderedEmail {
  const subject = `Confirm your ${BRAND} email`;
  const greeting = salutation(p.displayName);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="${S.body}">
<div style="${S.container}">
<h1 style="${S.heading}">Confirm your email</h1>
<p style="${S.paragraph}">${greeting}</p>
<p style="${S.paragraph}">Click the button below to confirm this email address for your ${BRAND} account.</p>
<p style="${S.paragraph}"><a href="${p.url}" style="${S.cta}">Confirm email</a></p>
<p style="${S.paragraph}">Or paste this link into your browser:<br><a href="${p.url}" style="${S.link}">${p.url}</a></p>
<p style="${S.fineprint}">If you didn't create a ${BRAND} account, ignore this email — no changes will be made.</p>
</div>
</body></html>`;
  const text = [
    `${greeting.replace("Hi,", "Hi")}`,
    ``,
    `Confirm your ${BRAND} email by opening this link:`,
    p.url,
    ``,
    `If you didn't create a ${BRAND} account, ignore this email.`,
  ].join("\n");
  return { subject, html, text };
}

export function renderPasswordReset(p: PasswordResetPayload): RenderedEmail {
  const subject = `Reset your ${BRAND} password`;
  const greeting = salutation(p.displayName);
  const ipLine = p.requestedIp
    ? `This reset was requested from ${escapeHtml(p.requestedIp)}.`
    : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="${S.body}">
<div style="${S.container}">
<h1 style="${S.heading}">Reset your password</h1>
<p style="${S.paragraph}">${greeting}</p>
<p style="${S.paragraph}">Click the button below to set a new ${BRAND} password. This link expires in ${escapeHtml(p.expiresIn)}.</p>
<p style="${S.paragraph}"><a href="${p.url}" style="${S.cta}">Reset password</a></p>
<p style="${S.paragraph}">Or paste this link into your browser:<br><a href="${p.url}" style="${S.link}">${p.url}</a></p>
<p style="${S.fineprint}">${ipLine ? `${ipLine} ` : ""}If this wasn't you, ignore this email and your password stays unchanged. For your security, every other signed-in session will be ended when you complete the reset.</p>
</div>
</body></html>`;
  const text = [
    `${greeting.replace("Hi,", "Hi")}`,
    ``,
    `Reset your ${BRAND} password by opening this link (expires in ${p.expiresIn}):`,
    p.url,
    ``,
    p.requestedIp ? `This reset was requested from ${p.requestedIp}.` : "",
    `If this wasn't you, ignore this email and your password stays unchanged.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { subject, html, text };
}
