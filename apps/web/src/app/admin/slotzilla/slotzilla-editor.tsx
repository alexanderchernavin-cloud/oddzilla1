"use client";

import { useState } from "react";
import { unwrapObject, type SlotzillaConfigDto } from "./slotzilla-admin-types";
import { FeedStatusCard } from "./feed-status-card";
import { SettingsTab } from "./settings-tab";
import { PaytablesTab } from "./paytables-tab";
import { GamesTab } from "./games-tab";
import { CorpusTab } from "./corpus-tab";
import { Chip } from "./ui";

// The SlotZilla backoffice: a feed-status strip and four tabs. Each tab
// owns its data and reloads from the api after every mutation (the
// ComboZilla editor's rule — one GET beats a local merge). The config is
// the one thing shared across tabs: the Paytables fitter defaults to its
// return target and the Games desk compares realised return against it,
// so it lives here and Settings pushes every save back up.
//
// The SSR page passes each endpoint's raw payload, or null when that
// fetch came back non-2xx; a null tab renders a retry rather than
// blanking the whole page, since the routes ship with a separate api
// deploy and an operator may open this before they exist.

export interface SlotzillaAdminInitial {
  config: unknown;
  paytables: unknown;
  games: unknown;
  status: unknown;
  corpus: unknown;
}

const TABS = [
  { id: "settings", label: "Settings" },
  { id: "paytables", label: "Paytables" },
  { id: "games", label: "Games" },
  { id: "corpus", label: "Corpus" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SlotzillaEditor({ initial }: { initial: SlotzillaAdminInitial }) {
  const [config, setConfig] = useState<SlotzillaConfigDto | null>(() =>
    unwrapObject<SlotzillaConfigDto>(initial.config, "config"),
  );
  const [tab, setTab] = useState<TabId>("settings");

  const target = config?.rtpTargetBp ?? null;

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1180 }}>
      <FeedStatusCard initial={initial.status} />

      <div
        role="tablist"
        aria-label="SlotZilla sections"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--color-border, var(--border))",
        }}
      >
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.id)}
              style={{
                height: 38,
                padding: "0 14px",
                border: 0,
                borderBottom: `2px solid ${on ? "var(--accent, #16a34a)" : "transparent"}`,
                marginBottom: -1,
                background: "transparent",
                fontFamily: "inherit",
                fontSize: 13.5,
                fontWeight: 600,
                color: on ? "var(--color-fg, var(--fg))" : "var(--color-fg-muted, var(--fg-muted))",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, paddingRight: 4 }}>
          {config ? (
            config.enabled ? (
              <Chip tone="accent">enabled</Chip>
            ) : (
              <Chip tone="negative">disabled</Chip>
            )
          ) : null}
        </span>
      </div>

      <div role="tabpanel">
        {tab === "settings" ? <SettingsTab config={config} onConfigChange={setConfig} /> : null}
        {tab === "paytables" ? <PaytablesTab initial={initial.paytables} rtpTargetBp={target} /> : null}
        {tab === "games" ? <GamesTab initial={initial.games} rtpTargetBp={target} /> : null}
        {tab === "corpus" ? <CorpusTab initial={initial.corpus} /> : null}
      </div>
    </div>
  );
}
