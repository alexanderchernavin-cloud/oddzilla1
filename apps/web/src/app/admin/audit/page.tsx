import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";

interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  ipInet: string | null;
  createdAt: string;
}
interface ListResponse {
  entries: AuditEntry[];
  limit: number;
  offset: number;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    actorId?: string;
    targetType?: string;
    targetId?: string;
    action?: string;
    offset?: string;
  }>;
}) {
  const params = await searchParams;
  const offset = Number(params.offset ?? 0) || 0;

  const qs = new URLSearchParams({ limit: "100", offset: String(offset) });
  if (params.actorId) qs.set("actorId", params.actorId);
  if (params.targetType) qs.set("targetType", params.targetType);
  if (params.targetId) qs.set("targetId", params.targetId);
  if (params.action) qs.set("action", params.action);

  const data = await serverApi<ListResponse>(`/admin/audit?${qs.toString()}`);
  const entries = data?.entries ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Every admin mutation lands here. Filter by actor, target, or action prefix.
      </p>

      <form className="mt-6 flex flex-wrap items-end gap-3 text-sm" action="/admin/audit">
        <Field name="action" label="Action prefix" defaultValue={params.action} />
        <Field name="targetType" label="Target type" defaultValue={params.targetType} />
        <Field name="targetId" label="Target id" defaultValue={params.targetId} />
        <Field name="actorId" label="Actor id (UUID)" defaultValue={params.actorId} />
        <button
          type="submit"
          className="rounded-[8px] border border-[var(--color-accent)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
        >
          Apply
        </button>
      </form>

      {entries.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">No entries.</p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {entries.map((e) => (
            <li key={e.id} className="p-4">
              <div className="flex items-center justify-between gap-4 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                <div className="truncate">
                  <span className="text-[var(--color-accent)]">{e.action}</span>
                  {e.targetType ? (
                    <>
                      {" · "}
                      <span>{e.targetType}</span>
                      {e.targetId ? (
                        <>
                          <span className="text-[var(--color-fg-subtle)]"> / </span>
                          <span className="font-mono normal-case text-[var(--color-fg-muted)]">
                            {e.targetId}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <time dateTime={e.createdAt} className="whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {e.actorEmail ?? "—"}{" "}
                {e.ipInet ? (
                  <span className="font-mono text-[var(--color-fg-subtle)]">
                    {" · "}
                    {e.ipInet}
                  </span>
                ) : null}
              </p>
              {e.beforeJson || e.afterJson ? (
                <pre className="mt-2 overflow-x-auto rounded-[8px] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-fg-muted)]">
                  {JSON.stringify({ before: e.beforeJson, after: e.afterJson }, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <nav className="mt-4 flex items-center justify-between text-sm">
        <span className="text-[var(--color-fg-subtle)]">
          offset {offset} · {entries.length} shown
        </span>
        <div className="flex items-center gap-2">
          {offset > 0 ? (
            <Link
              href={buildHref(params, Math.max(0, offset - 100))}
              className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Previous
            </Link>
          ) : null}
          {entries.length >= 100 ? (
            <Link
              href={buildHref(params, offset + 100)}
              className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Next
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

function Field({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <input
        name={name}
        defaultValue={defaultValue ?? ""}
        className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-1.5 font-mono"
      />
    </label>
  );
}

function buildHref(
  params: {
    actorId?: string;
    targetType?: string;
    targetId?: string;
    action?: string;
  },
  offset: number,
): string {
  const qs = new URLSearchParams();
  if (params.actorId) qs.set("actorId", params.actorId);
  if (params.targetType) qs.set("targetType", params.targetType);
  if (params.targetId) qs.set("targetId", params.targetId);
  if (params.action) qs.set("action", params.action);
  qs.set("offset", String(offset));
  return `/admin/audit?${qs.toString()}`;
}
