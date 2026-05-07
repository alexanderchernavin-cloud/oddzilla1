"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface SportRow {
  id: number;
  provider: string;
  providerUrn: string;
  slug: string;
  name: string;
  kind: string;
  active: boolean;
  logoUrl: string | null;
  brandColor: string | null;
}

interface ListShape {
  total: number;
  missingLogoCount: number;
  limit: number;
  offset: number;
  sports: SportRow[];
}

interface Filters {
  q: string;
  missingLogo: boolean;
}

export function SportsEditor({
  initialList,
  currentFilters,
}: {
  initialList: ListShape;
  currentFilters: Filters;
}) {
  return (
    <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <FilterBar
        current={currentFilters}
        total={initialList.total}
        missingLogoCount={initialList.missingLogoCount}
      />
      <SportTable list={initialList} />
    </div>
  );
}

function FilterBar({
  current,
  total,
  missingLogoCount,
}: {
  current: Filters;
  total: number;
  missingLogoCount: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(current.q);

  const buildUrl = (next: Partial<Filters>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    const merged: Filters = { ...current, ...next };
    if (merged.q) params.set("q", merged.q);
    else params.delete("q");
    if (merged.missingLogo) params.set("missingLogo", "1");
    else params.delete("missingLogo");
    return `/admin/sports?${params.toString()}`;
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    router.push(buildUrl({ q }));
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "12px 14px",
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
      }}
    >
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or slug…"
          style={{
            height: 34,
            padding: "0 12px",
            background: "var(--color-bg, var(--bg))",
            border: "1px solid var(--color-border, var(--border))",
            borderRadius: 8,
            fontSize: 13,
            minWidth: 240,
            color: "var(--color-fg, var(--fg))",
          }}
        />
        <button
          type="submit"
          style={{
            height: 34,
            padding: "0 14px",
            background: "var(--accent, var(--fg))",
            color: "var(--accent-fg, var(--bg))",
            border: 0,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Search
        </button>
      </form>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={current.missingLogo}
          onChange={(e) => router.push(buildUrl({ missingLogo: e.target.checked }))}
        />
        <span>Missing logo only</span>
      </label>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 11.5, color: "var(--color-fg-muted, var(--fg-muted))" }}>
        {total} {total === 1 ? "sport" : "sports"} · {missingLogoCount} missing logo
      </span>
    </div>
  );
}

function SportTable({ list }: { list: ListShape }) {
  return (
    <div
      style={{
        background: "var(--color-bg, var(--bg))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px 1fr 1.4fr 1fr 110px",
          gap: 12,
          padding: "10px 14px",
          background: "var(--color-bg-subtle, var(--surface-2))",
          borderBottom: "1px solid var(--color-border, var(--border))",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--color-fg-muted, var(--fg-muted))",
          fontWeight: 600,
        }}
      >
        <span>Logo</span>
        <span>Sport</span>
        <span>Logo URL</span>
        <span>Brand colour</span>
        <span style={{ textAlign: "right" }}>Save</span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {list.sports.map((s) => (
          <SportRowEditor key={s.id} sport={s} />
        ))}
        {list.sports.length === 0 && (
          <li
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--color-fg-muted, var(--fg-muted))",
              fontSize: 13,
            }}
          >
            No sports match the current filter.
          </li>
        )}
      </ul>
    </div>
  );
}

function SportRowEditor({ sport }: { sport: SportRow }) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(sport.logoUrl ?? "");
  const [brandColor, setBrandColor] = useState(sport.brandColor ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    (sport.logoUrl ?? "") !== logoUrl || (sport.brandColor ?? "") !== brandColor;

  const onSave = () => {
    if (!dirty) return;
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/sports/${sport.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            logoUrl: logoUrl.trim() === "" ? null : logoUrl.trim(),
            brandColor: brandColor.trim() === "" ? null : brandColor.trim(),
          }),
        });
        setSavedAt(Date.now());
        router.refresh();
      } catch (e) {
        if (e instanceof ApiFetchError) setError(e.message);
        else setError("Save failed. Please try again.");
      }
    });
  };

  // The fallback static SVG path the storefront would use when logoUrl
  // is null — admins can paste this back in if they want to "reset" to
  // the bundled brand SVG without redeploying.
  const fallbackHint = `/sports/${sport.slug}.svg`;

  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr 1.4fr 1fr 110px",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderBottom: "1px solid var(--hairline, var(--border))",
      }}
    >
      <SportLogoPreview url={logoUrl || sport.logoUrl} fallbackPath={fallbackHint} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{sport.name}</span>
        <span
          className="mono"
          style={{ fontSize: 11, color: "var(--color-fg-muted, var(--fg-muted))" }}
        >
          {sport.slug}
        </span>
      </div>
      <input
        type="text"
        value={logoUrl}
        onChange={(e) => setLogoUrl(e.target.value)}
        placeholder={fallbackHint}
        style={{
          height: 32,
          padding: "0 10px",
          background: "var(--color-bg, var(--bg))",
          border: "1px solid var(--color-border, var(--border))",
          borderRadius: 6,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 12,
          color: "var(--color-fg, var(--fg))",
          minWidth: 0,
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          value={brandColor}
          onChange={(e) => setBrandColor(e.target.value)}
          placeholder="#RRGGBB"
          style={{
            height: 32,
            width: 110,
            padding: "0 10px",
            background: "var(--color-bg, var(--bg))",
            border: "1px solid var(--color-border, var(--border))",
            borderRadius: 6,
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 12,
            color: "var(--color-fg, var(--fg))",
          }}
        />
        {brandColor && /^#[0-9A-Fa-f]{6}$/u.test(brandColor) && (
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: brandColor,
              border: "1px solid var(--color-border, var(--border))",
            }}
          />
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || pending}
          style={{
            height: 32,
            padding: "0 14px",
            background: dirty
              ? "var(--accent, var(--fg))"
              : "var(--color-bg-subtle, var(--surface-2))",
            color: dirty
              ? "var(--accent-fg, var(--bg))"
              : "var(--color-fg-muted, var(--fg-muted))",
            border: 0,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: dirty && !pending ? "pointer" : "default",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : dirty ? "Save" : savedAt ? "Saved" : "—"}
        </button>
        {error && (
          <span
            style={{
              fontSize: 10.5,
              color: "var(--negative, #b4332a)",
              maxWidth: 110,
              textAlign: "right",
              lineHeight: 1.3,
            }}
          >
            {error}
          </span>
        )}
      </div>
    </li>
  );
}

function SportLogoPreview({
  url,
  fallbackPath,
}: {
  url: string | null;
  fallbackPath: string;
}) {
  const [errored, setErrored] = useState(false);
  const src = url && url.length > 0 ? url : fallbackPath;
  return (
    <div
      style={{
        width: 36,
        height: 36,
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {!errored && src ? (
        <img
          src={src}
          alt=""
          width={28}
          height={28}
          onError={() => setErrored(true)}
          style={{ width: 28, height: 28, objectFit: "contain" }}
        />
      ) : (
        <span
          style={{
            fontSize: 9,
            color: "var(--color-fg-muted, var(--fg-muted))",
          }}
        >
          —
        </span>
      )}
    </div>
  );
}
