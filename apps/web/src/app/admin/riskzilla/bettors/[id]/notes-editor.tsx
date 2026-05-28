"use client";

// Free-text operator notes — PUT /admin/users/:id/notes.
//
// Plain text, capped at 4000 chars (matches the DB CHECK). Empty string
// clears the field server-side. Audit-logged, so notes changes show up
// in the same per-bettor audit feed below.

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const MAX_LEN = 4000;

export function NotesEditor({
  userId,
  initial,
}: {
  userId: string;
  initial: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(initial ?? "");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const dirty = text !== (initial ?? "");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    if (text.length > MAX_LEN) {
      setMsg({ kind: "err", text: `Notes capped at ${MAX_LEN} chars.` });
      return;
    }

    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${userId}/notes`, {
          method: "PUT",
          body: JSON.stringify({ notes: text }),
        });
        setMsg({
          kind: "ok",
          text: text.trim() === "" ? "Notes cleared." : "Notes saved.",
        });
        // Refresh the surrounding RSC so the audit-log card picks up
        // the user.notes_update entry on next render.
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text: err instanceof ApiFetchError ? err.message : "Save failed.",
        });
      }
    });
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMsg(null);
        }}
        maxLength={MAX_LEN}
        rows={6}
        placeholder="Pin context: VIP status, support history, behavioural flags, last contact date…"
        spellCheck={false}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 13,
          lineHeight: 1.5,
          background: "var(--color-bg-card)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: 10,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>
          {text.length}/{MAX_LEN} chars · audit-logged on save
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {dirty && initial !== null ? (
            <button
              type="button"
              onClick={() => {
                setText(initial ?? "");
                setMsg(null);
              }}
              disabled={pending}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                background: "transparent",
                color: "var(--color-fg-muted)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              Discard
            </button>
          ) : null}
          <button
            type="submit"
            disabled={pending || !dirty}
            style={{
              fontSize: 12,
              padding: "6px 14px",
              background: dirty ? "var(--color-fg)" : "var(--color-bg-subtle)",
              color: dirty ? "var(--color-bg)" : "var(--color-fg-muted)",
              border: "none",
              borderRadius: 8,
              cursor: pending || !dirty ? "not-allowed" : "pointer",
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending ? "Saving…" : "Save notes"}
          </button>
        </div>
      </div>
      {msg ? (
        <p
          style={{
            fontSize: 12,
            color:
              msg.kind === "ok"
                ? "var(--color-positive, #3a8a3a)"
                : "var(--color-negative, #c1342f)",
            margin: 0,
          }}
        >
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}
