import type { Metadata } from "next";
import { CookiePreferencesButton } from "@/components/shell/cookie-preferences-button";

// Privacy & Cookies Policy. Legal text is intentionally maintained in
// English only — translations of legal documents drift from the
// authoritative wording and multiply review cost; the page chrome
// (nav, footer) stays localized. Operator identity below carries
// bracketed placeholders that MUST be filled in with the real legal
// entity before real-money launch — this document is a working
// template, not reviewed legal advice.

export const metadata: Metadata = {
  title: "Privacy & Cookies Policy — Oddzilla",
  description:
    "How Oddzilla collects, uses, and protects personal data, and which cookies the site uses.",
};

const LAST_UPDATED = "2 July 2026";

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="display"
      style={{ fontSize: 26, fontWeight: 400, margin: "36px 0 12px" }}
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 15, fontWeight: 600, margin: "24px 0 8px" }}>
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 14,
        lineHeight: 1.65,
        color: "var(--fg-muted)",
        margin: "0 0 12px",
      }}
    >
      {children}
    </p>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li
      style={{
        fontSize: 14,
        lineHeight: 1.65,
        color: "var(--fg-muted)",
        marginBottom: 6,
      }}
    >
      {children}
    </li>
  );
}

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--fg-muted)",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
  textAlign: "left",
};

const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: "var(--fg)",
  fontWeight: 600,
  borderBottom: "1px solid var(--border-strong)",
};

export default function PrivacyPage() {
  return (
    <div style={{ paddingTop: 56, paddingBottom: 24 }}>
      <article style={{ maxWidth: 760 }}>
        <h1
          className="display"
          style={{ fontSize: 40, fontWeight: 400, margin: "0 0 4px" }}
        >
          Privacy &amp; Cookies Policy
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-dim)", margin: "0 0 24px" }}>
          Last updated: {LAST_UPDATED}
        </p>

        <P>
          This page explains how Oddzilla (&ldquo;we&rdquo;, &ldquo;us&rdquo;)
          collects and uses personal data when you use oddzilla.cc, and which
          cookies and similar technologies the site relies on. It is written to
          meet the requirements of the EU General Data Protection Regulation
          (GDPR) and the ePrivacy Directive. This document is provided in
          English.
        </P>

        <H2>Privacy Policy</H2>

        <H3>1. Who we are</H3>
        <P>
          The data controller for oddzilla.cc is [OPERATOR LEGAL ENTITY],
          registered at [REGISTERED ADDRESS]. For any privacy matter, contact
          us at privacy@oddzilla.cc.
        </P>

        <H3>2. Personal data we collect</H3>
        <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
          <Li>
            Account data: email address, password (stored only as a salted
            argon2id hash), account status, and settings.
          </Li>
          <Li>
            Optional profile data: nickname, bio, avatar choice, and — if you
            keep ticket visibility on — your settled bets shown in the
            community feed under your nickname.
          </Li>
          <Li>
            Betting activity: bets placed, stakes, odds, settlement results,
            cash-outs, and wallet balances.
          </Li>
          <Li>
            Payment data: deposit transaction hashes and withdrawal addresses
            on public blockchains (USDC on Ethereum). Blockchain transactions
            are public by design and cannot be erased from the chain.
          </Li>
          <Li>
            Communications: support chat messages and emails you send us.
          </Li>
          <Li>
            Device data for push notifications (only if you install our
            Android app and grant notification permission): a push token and
            platform identifier.
          </Li>
          <Li>
            Technical data: IP address, browser user agent, request
            identifiers, and timestamps in server logs, used for security and
            troubleshooting.
          </Li>
          <Li>
            Usage analytics (only with your consent): pages visited, clicks,
            session length, and sampled mouse movement, tied to a per-tab
            session identifier and — if you are signed in — to your account.
            Collected and processed exclusively on our own servers; no
            third-party analytics vendor is involved.
          </Li>
        </ul>

        <H3>3. Why we process it</H3>
        <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
          <Li>
            To provide the service — account management, accepting and
            settling bets, deposits and withdrawals (performance of a
            contract, art. 6(1)(b) GDPR).
          </Li>
          <Li>
            To meet legal obligations — accounting, anti-money-laundering and
            responsible-gambling duties where applicable (art. 6(1)(c)).
          </Li>
          <Li>
            For our legitimate interests — fraud prevention, risk management,
            platform security, and audit trails (art. 6(1)(f)).
          </Li>
          <Li>
            With your consent — push notifications, third-party embedded
            media cookies, and first-party usage analytics (art. 6(1)(a)).
            You can withdraw consent at any time.
          </Li>
        </ul>

        <H3>4. Who we share it with</H3>
        <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
          <Li>
            Oddin.gg — our licensed esports odds and data partner. Match,
            market, and settlement data flows between us; widget embeds are
            served from their infrastructure.
          </Li>
          <Li>
            Hetzner Online GmbH (Germany) — server hosting inside the EU.
          </Li>
          <Li>
            Resend, Inc. (USA) — delivery of transactional emails such as
            email verification and password resets.
          </Li>
          <Li>
            Google LLC / Firebase (USA) — push notification delivery for the
            Android app, if you opt in.
          </Li>
          <Li>
            Streaming platforms (Twitch, YouTube, Kick, Gjirafa) — only when
            you consent to third-party media and load an embedded stream.
          </Li>
          <Li>
            Public authorities where the law requires it.
          </Li>
        </ul>
        <P>
          We do not sell personal data and we run no advertising or
          third-party analytics trackers. Usage analytics, when you consent
          to them, are collected first-party and stay on our own servers.
        </P>

        <H3>5. International transfers</H3>
        <P>
          Our servers are in the EU. Where a processor is based outside the
          EEA (Resend, Google), transfers rely on the EU&ndash;US Data Privacy
          Framework or Standard Contractual Clauses.
        </P>

        <H3>6. How long we keep it</H3>
        <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
          <Li>
            Account and betting records: for the life of the account and
            afterwards as long as statutory retention (accounting, AML)
            requires.
          </Li>
          <Li>Odds history: 90 days.</Li>
          <Li>Raw feed message logs: 7 days.</Li>
          <Li>Database backups: 14 days.</Li>
          <Li>
            Usage analytics (if consented): sessions and events 90 days,
            mouse-movement samples 14 days.
          </Li>
          <Li>
            Server logs: rotated automatically (approximately 50 MB per
            service).
          </Li>
        </ul>

        <H3>7. Your rights</H3>
        <P>
          Under the GDPR you can ask us for access to, rectification or
          erasure of your personal data, restriction of processing, data
          portability, and you can object to processing based on legitimate
          interests. Where processing is based on consent you can withdraw it
          at any time without affecting prior processing. Write to
          privacy@oddzilla.cc — we respond within one month. You also have the
          right to lodge a complaint with your local supervisory authority.
        </P>

        <H3>8. Security</H3>
        <P>
          All traffic is encrypted in transit (TLS). Passwords are hashed with
          argon2id. Wallet key material is isolated in a dedicated signing
          service. Administrative actions are recorded in a tamper-evident
          audit log.
        </P>

        <H3>9. Age requirement</H3>
        <P>
          Oddzilla is strictly for adults aged 18 or over. We do not knowingly
          process data of minors; accounts found to belong to minors are
          closed.
        </P>

        <H3>10. Changes</H3>
        <P>
          We will update this page when our practices change and revise the
          date at the top. Material changes are announced in the product.
        </P>

        <H2>Cookies Policy</H2>

        <P>
          Cookies are small files stored on your device. We group them into
          three categories. Strictly necessary cookies are required for the
          site to function (signing in, security, remembering your language)
          and are exempt from consent. Third-party media cookies are set by
          external providers when you load embedded streams or statistics
          widgets. First-party analytics storage supports our own usage
          statistics. The last two are off until you allow them in the cookie
          banner.
        </P>

        <H3>Strictly necessary cookies and storage</H3>
        <div style={{ overflowX: "auto", margin: "0 0 12px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Name</th>
                <th style={headCellStyle}>Purpose</th>
                <th style={headCellStyle}>Duration</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={cellStyle}>oddzilla_access</td>
                <td style={cellStyle}>Keeps you signed in (session token)</td>
                <td style={cellStyle}>15 minutes</td>
              </tr>
              <tr>
                <td style={cellStyle}>oddzilla_refresh</td>
                <td style={cellStyle}>Renews your session securely</td>
                <td style={cellStyle}>30 days</td>
              </tr>
              <tr>
                <td style={cellStyle}>oz_locale</td>
                <td style={cellStyle}>Remembers your language</td>
                <td style={cellStyle}>12 months</td>
              </tr>
              <tr>
                <td style={cellStyle}>
                  Local storage (oz:theme, oz:cookie-consent, bet-slip
                  preferences)
                </td>
                <td style={cellStyle}>
                  Remembers your theme, your cookie choice, and slip settings.
                  Stays on your device; never sent to us.
                </td>
                <td style={cellStyle}>Until cleared</td>
              </tr>
            </tbody>
          </table>
        </div>

        <H3>Third-party media (consent required)</H3>
        <P>
          Match pages can embed live streams and statistics widgets from
          Twitch, YouTube, Kick, Gjirafa, and Oddin. These providers may set
          their own cookies and process your IP address under their own
          privacy policies. We block these embeds until you choose
          &ldquo;Accept all&rdquo; or enable the third-party media category —
          and if you decline, they stay off.
        </P>

        <H3>First-party analytics (consent required)</H3>
        <P>
          With your consent, we record how the site is used — pages visited,
          clicks, session length, and sampled mouse movement — to improve the
          product. A random session identifier (oz:analytics:session) is kept
          in your browser&rsquo;s session storage for at most 30 minutes of
          inactivity and is created only after you consent. The data is
          processed exclusively on our own servers and is never shared with
          or sold to anyone. Declining or withdrawing consent stops
          collection immediately and removes the identifier.
        </P>

        <H3>Managing your preferences</H3>
        <P>
          You can change or withdraw your cookie consent at any time — use
          the button below or the &ldquo;Cookie preferences&rdquo; link in the
          footer. You can also delete cookies through your browser settings.
        </P>
        <div style={{ margin: "16px 0 8px" }}>
          <CookiePreferencesButton />
        </div>
      </article>
    </div>
  );
}
