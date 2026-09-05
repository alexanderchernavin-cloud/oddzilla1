"use client";

// Pin / move / unpin controls for an operator-ordered catalog row
// (migration 0103). Shared by /admin/sports and /admin/categories
// because both sit on the identical endpoint shape —
// POST <base>/:id/order { action } — and the two tables would otherwise
// drift in what "up" means the first time one of them is touched.
//
// The row is the whole control surface: an unpinned row offers one
// button ("Pin to top"), a pinned row shows its position and the moves.
// There is no drag-and-drop and no numeric field, because both pages are
// paginated lists an operator lands on to change one thing, and the ask
// is specifically to lift a few rows above a long alphabetical tail
// rather than to sequence the whole catalogue.
//
// Styled inline rather than with the admin `.btn` utility: the bare
// `.btn` carries no background or border (only `.btn-primary` /
// `.btn-ghost` do), and the two host tables are written in different
// idioms — /admin/categories in Tailwind classes, /admin/sports in
// inline styles. Self-contained styling means the control looks the
// same in both.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export type PinAction = "top" | "up" | "down" | "clear";

const buttonBase: React.CSSProperties = {
  height: 26,
  minWidth: 26,
  padding: "0 7px",
  background: "var(--color-bg-subtle, var(--surface-2))",
  color: "var(--color-fg, var(--fg))",
  border: "1px solid var(--color-border, var(--border))",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
  fontFamily: "inherit",
};

export function PinOrderControls({
  basePath,
  id,
  displayOrder,
  first,
  last,
  label,
}: {
  /** Collection path without the id, e.g. "/admin/sports". */
  basePath: string;
  id: number;
  /** Current pin position, or null when the row is unpinned. */
  displayOrder: number | null;
  /** True when this is the first pinned row in its scope. */
  first: boolean;
  /** True when this is the last pinned row in its scope. */
  last: boolean;
  /** Name of the thing, for button titles. */
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function send(action: PinAction) {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`${basePath}/${id}/order`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        // The row's new position, and every position it displaced, come
        // from the server — refresh rather than patch local state, or
        // the neighbours' numbers go stale the moment one row moves.
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Save failed.");
      }
    });
  }

  function move(action: PinAction, glyph: string, title: string, disabled: boolean) {
    return (
      <button
        type="button"
        onClick={() => send(action)}
        disabled={pending || disabled}
        title={title}
        aria-label={title}
        style={{
          ...buttonBase,
          cursor: pending || disabled ? "default" : "pointer",
          opacity: pending || disabled ? 0.4 : 1,
        }}
      >
        {glyph}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {displayOrder == null ? (
        <button
          type="button"
          onClick={() => send("top")}
          disabled={pending}
          title={`Pin ${label} to the top of the storefront list`}
          style={{
            ...buttonBase,
            alignSelf: "flex-start",
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : "Pin to top"}
        </button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            title={`Pinned at position ${displayOrder}`}
            style={{
              height: 26,
              minWidth: 26,
              padding: "0 7px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--color-accent, var(--accent))",
              color: "var(--color-accent-fg, var(--accent-fg))",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {displayOrder}
          </span>
          {move("top", "⤒", `Move ${label} to the top`, first)}
          {move("up", "↑", `Move ${label} up`, first)}
          {move("down", "↓", `Move ${label} down`, last)}
          {move("clear", "✕", `Unpin ${label} — back to the default order`, false)}
        </div>
      )}
      {error && (
        <span style={{ fontSize: 11, color: "var(--color-danger, var(--danger))" }}>
          {error}
        </span>
      )}
    </div>
  );
}
