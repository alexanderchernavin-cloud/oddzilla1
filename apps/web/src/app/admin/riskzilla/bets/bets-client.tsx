"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { EventRow, type EventDto } from "../events-row";

export function BetsClient() {
  const [rows, setRows] = useState<EventDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    status: "all" as "all" | "accepted" | "rejected",
    riskTier: "" as string,
    fromTs: "" as string,
    toTs: "" as string,
  });
  const [hasMore, setHasMore] = useState(true);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "100");
    if (filters.status !== "all") p.set("status", filters.status);
    if (filters.riskTier) p.set("riskTier", filters.riskTier);
    if (filters.fromTs) p.set("fromTs", new Date(filters.fromTs).toISOString());
    if (filters.toTs) p.set("toTs", new Date(filters.toTs).toISOString());
    return p.toString();
  }, [filters]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi<{ entries: EventDto[] }>(
        `/admin/riskzilla/events?${queryString}`,
      );
      setRows(res.entries);
      setHasMore(res.entries.length >= 100);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoading(true);
    try {
      const cursor = rows[rows.length - 1]!.cursor;
      const p = new URLSearchParams(queryString);
      p.set("before", cursor);
      const res = await clientApi<{ entries: EventDto[] }>(
        `/admin/riskzilla/events?${p.toString()}`,
      );
      setRows((prev) => [...prev, ...res.entries]);
      setHasMore(res.entries.length >= 100);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "auto auto auto auto auto",
          gap: 8,
          alignItems: "center",
        }}
      >
        <FilterLabel label="Status">
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value as "all" | "accepted" | "rejected",
              }))
            }
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>
        </FilterLabel>
        <FilterLabel label="Risk tier">
          <select
            value={filters.riskTier}
            onChange={(e) => setFilters((f) => ({ ...f, riskTier: e.target.value }))}
            style={selectStyle}
          >
            <option value="">Any</option>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "0 (default)" : n}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label="From">
          <input
            type="datetime-local"
            value={filters.fromTs}
            onChange={(e) => setFilters((f) => ({ ...f, fromTs: e.target.value }))}
            style={selectStyle}
          />
        </FilterLabel>
        <FilterLabel label="To">
          <input
            type="datetime-local"
            value={filters.toTs}
            onChange={(e) => setFilters((f) => ({ ...f, toTs: e.target.value }))}
            style={selectStyle}
          />
        </FilterLabel>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          style={{
            height: 32,
            padding: "0 14px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            color: "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </section>

      {error && (
        <div
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 && !loading ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No matching events.
          </p>
        ) : (
          rows.map((r) => <EventRow key={r.id} row={r} />)
        )}
      </div>

      {hasMore && rows.length > 0 && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
          style={{
            alignSelf: "center",
            height: 32,
            padding: "0 16px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            color: "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );
}

function FilterLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--color-fg-muted)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const selectStyle: React.CSSProperties = {
  height: 32,
  padding: "0 8px",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  borderRadius: 6,
  fontSize: 13,
};
