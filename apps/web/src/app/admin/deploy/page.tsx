// /admin/deploy — read-only view of the deploy pipeline.
//
// Server-rendered: each page load fetches `/admin/deploy/status` once
// via the cookie-forwarding server-fetch helper. The page intentionally
// does NOT auto-poll. Deploys are operator-driven via SSH +
// `make deploy`, and the api caches the response for 15s anyway, so
// "refresh the page after running a deploy" is the right cadence.
//
// Triggering a deploy / rollback from this page is intentionally not
// implemented — see services/api/src/modules/admin/deploy.ts for the
// rationale (giving api docker socket + sudo flips the security model).

import { serverApi } from "@/lib/server-fetch";

export const metadata = {
  title: "Deploy — Oddzilla Admin",
};

// Mirrors services/api/src/modules/admin/deploy.ts.
interface CommitMeta {
  sha: string;
  short: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
}
interface PendingCommit extends CommitMeta {
  filesChanged: number;
}
interface DeployLogEntry {
  ts: string;
  kind: string;
  sha: string;
  short: string;
  services: string[];
  extras: Record<string, string>;
}
interface RollbackTarget {
  service: string;
  currentSha: string | null;
  currentShort: string | null;
  currentImagePresent: boolean;
  previousSha: string | null;
  previousShort: string | null;
  previousImagePresent: boolean;
  history: Array<{ sha: string; short: string; imagePresent: boolean }>;
}
interface BackupEntry {
  file: string;
  sha: string;
  short: string;
  bytes: number;
  modifiedAt: string;
}
interface DeployStatus {
  available: boolean;
  reason: string | null;
  current: {
    sha: string | null;
    short: string | null;
    commit: CommitMeta | null;
    deployedAt: string | null;
  };
  pending: {
    targetSha: string | null;
    targetShort: string | null;
    commits: PendingCommit[];
    services: string[];
    migrations: string[];
  };
  log: DeployLogEntry[];
  rollback: RollbackTarget[];
  backups: BackupEntry[];
}

export default async function DeployPage() {
  const data = await serverApi<DeployStatus>("/admin/deploy/status");

  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={headingStyle}>Deploy</h1>
        <p style={paragraphStyle}>
          Could not reach <code>/admin/deploy/status</code>. The api may be
          restarting; refresh in a few seconds.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "0 0 64px" }}>
      <Header status={data} />

      {!data.available && (
        <Card>
          <p style={paragraphStyle}>
            Deploy state is not available in this environment.
            {data.reason ? (
              <>
                {" "}
                Reason: <code>{data.reason}</code>
              </>
            ) : null}
          </p>
          <p style={{ ...paragraphStyle, color: "var(--fg-dim)" }}>
            On the production box this page reads <code>.deploy/</code> +{" "}
            <code>.git/</code> bind-mounted into the api container.
          </p>
        </Card>
      )}

      {data.available && (
        <>
          <PendingSection status={data} />
          <DeployLogSection status={data} />
          <RollbackSection status={data} />
          <BackupsSection status={data} />
        </>
      )}
    </div>
  );
}

// ── Header / status banner ─────────────────────────────────────────

function Header({ status }: { status: DeployStatus }) {
  const current = status.current;
  const pending = status.pending;
  const hasPending = pending.commits.length > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <h1 style={headingStyle}>Deploy</h1>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          flexWrap: "wrap",
          color: "var(--fg-muted)",
          fontSize: 13,
        }}
      >
        <span>
          Running{" "}
          <ShaPill sha={current.short ?? "—"} />{" "}
          {current.commit ? (
            <span style={{ marginLeft: 4 }}>{current.commit.subject}</span>
          ) : null}
        </span>
        {current.deployedAt && (
          <span style={{ color: "var(--fg-dim)" }}>
            deployed <RelativeTime ts={current.deployedAt} />
          </span>
        )}
        {hasPending ? (
          <span
            className="mono"
            style={{
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 4,
              background: "var(--color-warn-bg, rgba(217, 119, 6, 0.12))",
              color: "var(--color-warn, #b45309)",
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {pending.commits.length} pending
          </span>
        ) : (
          <span
            className="mono"
            style={{
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 4,
              background: "var(--color-positive-bg, rgba(16, 185, 129, 0.12))",
              color: "var(--color-positive, #047857)",
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            up to date
          </span>
        )}
      </div>
    </div>
  );
}

// ── Pending deploy preview ─────────────────────────────────────────

function PendingSection({ status }: { status: DeployStatus }) {
  const { pending } = status;
  if (pending.commits.length === 0) {
    return (
      <Card title="What would deploy next">
        <p style={paragraphStyle}>
          <code>origin/main</code> matches the deployed SHA. Nothing to deploy.
        </p>
        <p style={{ ...paragraphStyle, color: "var(--fg-dim)" }}>
          When new commits land, they'll show up here with the services that
          would rebuild and any migrations that would run.
        </p>
      </Card>
    );
  }

  return (
    <Card title={`What would deploy next (${pending.commits.length} commit${pending.commits.length === 1 ? "" : "s"})`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SummaryRow status={status} />
        <CommitList commits={pending.commits} />
      </div>
    </Card>
  );
}

function SummaryRow({ status }: { status: DeployStatus }) {
  const { pending } = status;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        rowGap: 6,
        columnGap: 16,
        fontSize: 13,
      }}
    >
      <Label>Target</Label>
      <span>
        <ShaPill sha={pending.targetShort ?? "—"} /> {" "}
        <span style={{ color: "var(--fg-dim)" }}>(origin/main)</span>
      </span>

      <Label>Services to rebuild</Label>
      <span>
        {pending.services.length === 0 ? (
          <span style={{ color: "var(--fg-dim)" }}>
            none — docs / infra-only change
          </span>
        ) : (
          pending.services.map((s) => (
            <ServiceChip key={s} name={s} />
          ))
        )}
      </span>

      <Label>Migrations</Label>
      <span>
        {pending.migrations.length === 0 ? (
          <span style={{ color: "var(--fg-dim)" }}>none</span>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {pending.migrations.map((m) => (
              <li key={m} style={{ fontFamily: "var(--font-mono)" }}>
                {m}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}

function CommitList({ commits }: { commits: PendingCommit[] }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {commits.map((c) => (
        <li
          key={c.sha}
          style={{
            display: "flex",
            gap: 10,
            padding: "8px 0",
            borderTop: "1px solid var(--hairline)",
            fontSize: 13,
          }}
        >
          <ShaPill sha={c.short} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.subject}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>
              {c.authorName} · <RelativeTime ts={c.authoredAt} /> ·{" "}
              {c.filesChanged} file{c.filesChanged === 1 ? "" : "s"}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Deploy log ─────────────────────────────────────────────────────

function DeployLogSection({ status }: { status: DeployStatus }) {
  if (status.log.length === 0) {
    return (
      <Card title="Past deploys">
        <p style={paragraphStyle}>No deploy events recorded yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Past deploys">
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Kind</Th>
            <Th>SHA</Th>
            <Th>Services</Th>
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody>
          {status.log.map((e, i) => (
            <tr key={`${e.ts}-${i}`}>
              <Td><RelativeTime ts={e.ts} /></Td>
              <Td><KindBadge kind={e.kind} /></Td>
              <Td><ShaPill sha={e.short} /></Td>
              <Td>
                {e.services.length === 0
                  ? <span style={{ color: "var(--fg-dim)" }}>—</span>
                  : e.services.map((s) => <ServiceChip key={s} name={s} />)}
              </Td>
              <Td>
                {Object.entries(e.extras).length === 0
                  ? <span style={{ color: "var(--fg-dim)" }}>—</span>
                  : (
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                        {Object.entries(e.extras)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" ")}
                      </span>
                    )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    deploy: { bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" },
    rollback: { bg: "rgba(217, 119, 6, 0.12)", fg: "#b45309" },
    smoke_fail: { bg: "rgba(220, 38, 38, 0.12)", fg: "#b91c1c" },
  };
  const c = palette[kind] ?? { bg: "var(--surface-2)", fg: "var(--fg-muted)" };
  return (
    <span
      className="mono"
      style={{
        padding: "2px 6px",
        borderRadius: 4,
        background: c.bg,
        color: c.fg,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
      }}
    >
      {kind}
    </span>
  );
}

// ── Rollback targets ───────────────────────────────────────────────

function RollbackSection({ status }: { status: DeployStatus }) {
  if (status.rollback.length === 0) {
    return (
      <Card title="Rollback targets">
        <p style={paragraphStyle}>
          No service images recorded yet. After the next deploy, each touched
          service's previous SHA will be available here for{" "}
          <code>make rollback</code>.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Rollback targets">
      <p style={{ ...paragraphStyle, color: "var(--fg-dim)" }}>
        For each service, the SHA <code>make rollback</code> would retag back
        to <code>:latest</code>. Retention keeps 3 SHAs per service; anything
        older has been pruned and can't be rolled back to without a full
        rebuild.
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>Current</Th>
            <Th>Rollback target</Th>
            <Th>History</Th>
          </tr>
        </thead>
        <tbody>
          {status.rollback.map((r) => (
            <tr key={r.service}>
              <Td><ServiceChip name={r.service} /></Td>
              <Td>
                {r.currentShort ? (
                  <ShaPill sha={r.currentShort} muted={!r.currentImagePresent} />
                ) : (
                  <span style={{ color: "var(--fg-dim)" }}>—</span>
                )}
              </Td>
              <Td>
                {r.previousShort ? (
                  <>
                    <ShaPill sha={r.previousShort} muted={!r.previousImagePresent} />
                    {!r.previousImagePresent && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "var(--fg-dim)" }}>
                        image pruned
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ color: "var(--fg-dim)" }}>
                    no prior deploy
                  </span>
                )}
              </Td>
              <Td>
                <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                  {r.history.length} SHA
                  {r.history.length === 1 ? "" : "s"} retained
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── Pre-deploy backups ─────────────────────────────────────────────

function BackupsSection({ status }: { status: DeployStatus }) {
  if (status.backups.length === 0) {
    return (
      <Card title="Pre-deploy backups">
        <p style={paragraphStyle}>
          No pre-deploy DB snapshots on disk. A snapshot is taken automatically
          right before any deploy that includes a new migration.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Pre-deploy backups">
      <p style={{ ...paragraphStyle, color: "var(--fg-dim)" }}>
        Taken automatically before any deploy that runs a new migration.
        Retention: last 10. To restore one, copy from the box:
        {" "}
        <code style={{ fontSize: 11 }}>
          team@.../home/team/oddzilla/.deploy/backups/&lt;file&gt;
        </code>
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>File</Th>
            <Th>SHA</Th>
            <Th>Size</Th>
            <Th>Taken</Th>
          </tr>
        </thead>
        <tbody>
          {status.backups.map((b) => (
            <tr key={b.file}>
              <Td><code style={{ fontSize: 11 }}>{b.file}</code></Td>
              <Td><ShaPill sha={b.short} /></Td>
              <Td>{formatBytes(b.bytes)}</Td>
              <Td><RelativeTime ts={b.modifiedAt} /></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 8,
        padding: 16,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {title && (
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--fg-dim)",
        fontWeight: 600,
        paddingTop: 3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function ShaPill({ sha, muted }: { sha: string; muted?: boolean }) {
  return (
    <code
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        background: muted ? "transparent" : "var(--surface-2)",
        border: muted ? "1px dashed var(--hairline)" : "none",
        fontSize: 11,
        color: muted ? "var(--fg-dim)" : "var(--fg)",
        whiteSpace: "nowrap",
      }}
    >
      {sha}
    </code>
  );
}

function ServiceChip({ name }: { name: string }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-block",
        padding: "1px 6px",
        marginRight: 4,
        borderRadius: 4,
        background: "var(--surface-2)",
        fontSize: 10.5,
        color: "var(--fg-muted)",
      }}
    >
      {name}
    </span>
  );
}

function RelativeTime({ ts }: { ts: string }) {
  // We render the absolute ISO timestamp on hover; the human-readable
  // "5 min ago" goes in the visible label. Both via Intl helpers so we
  // don't ship a date library to this page.
  const d = new Date(ts);
  const diffMs = Date.now() - d.getTime();
  return (
    <time
      dateTime={ts}
      title={d.toLocaleString()}
      style={{ whiteSpace: "nowrap" }}
    >
      {humanizeDelta(diffMs)}
    </time>
  );
}

function humanizeDelta(ms: number): string {
  const abs = Math.abs(ms);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const future = ms < 0;
  let val: string;
  if (abs < min) val = `${Math.floor(abs / 1000)}s`;
  else if (abs < hour) val = `${Math.floor(abs / min)}m`;
  else if (abs < day) val = `${Math.floor(abs / hour)}h`;
  else val = `${Math.floor(abs / day)}d`;
  return future ? `in ${val}` : `${val} ago`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MiB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

// ── Table primitives ──────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 8px",
        borderBottom: "1px solid var(--hairline)",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "8px 8px",
        borderBottom: "1px solid var(--hairline)",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const paragraphStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--fg)",
  lineHeight: 1.55,
};
