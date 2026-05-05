import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { LogsSearch } from "./logs-search";

interface SportRow {
  id: number;
  slug: string;
  name: string;
  matchCount: number;
}
interface ListResponse {
  sports: SportRow[];
}

export default async function LogsHomePage() {
  const data = await serverApi<ListResponse>("/admin/logs/sports");
  const sports = data?.sports ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feed logs</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Per-match odds history and raw AMQP message replay. Matches with
            at least one feed message in the 7-day retention window appear
            here; older entries are swept automatically.
          </p>
        </div>
        <LogsSearch />
      </div>

      {sports.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          No active sports.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {sports.map((s) => (
            <li key={s.slug}>
              <Link
                href={`/admin/logs/sports/${s.slug}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[var(--color-bg)]"
              >
                <div>
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    {s.slug}
                  </p>
                </div>
                <span className="rounded-[8px] border border-[var(--color-border-strong)] px-2 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                  {s.matchCount} match{s.matchCount === 1 ? "" : "es"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
