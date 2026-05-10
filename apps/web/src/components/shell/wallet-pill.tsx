"use client";

// Top-bar wallet pill with a built-in currency picker.
//
// Click the pill → popover lists every wallet (USDC / OZ) with its
// available balance. Click a row → bet-slip's `currency` flips to it
// (so the bet slip + this pill + every other consumer of the slip
// context update in lockstep). The "Open wallet" link at the bottom
// preserves the previous "click pill → /wallet" path.

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fromMicro } from "@oddzilla/types/money";
import type { Currency, WalletSnapshot } from "@oddzilla/types";
import { I } from "@/components/ui/icons";
import { Divider } from "@/components/ui/primitives";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi } from "@/lib/api-client";

const PILL_HEIGHT = 36;

// Custom event other code dispatches via dispatchWalletChanged() when
// wallet balances may have shifted from in-page actions (cashout
// accept, bet placement, refund). The top-bar pill listens for it
// and refetches /wallet so the user sees the new balance immediately
// instead of having to navigate first. The event name is private —
// only this module subscribes; external code goes through the
// exported helper below.
const WALLET_CHANGED_EVENT = "oz:wallet-changed";

export function dispatchWalletChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WALLET_CHANGED_EVENT));
}

const pillStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: PILL_HEIGHT,
  padding: "0 14px",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  flexShrink: 0,
  cursor: "pointer",
  font: "inherit",
  color: "var(--fg)",
};

export function WalletPill({ wallets }: { wallets?: WalletSnapshot[] }) {
  const slip = useBetSlip();
  const activeCurrency = slip.currency;
  // Locally-mirrored wallet list. Seeded from the SSR prop and kept
  // fresh by listening for WALLET_CHANGED_EVENT (dispatched by the
  // cashout flow + bet placement flow) — without this the top-bar
  // balance stays stale until the next full navigation.
  const [liveWallets, setLiveWallets] = useState<WalletSnapshot[] | undefined>(
    wallets,
  );
  useEffect(() => {
    setLiveWallets(wallets);
  }, [wallets]);
  useEffect(() => {
    function refresh() {
      clientApi<{ wallets: WalletSnapshot[] }>("/wallet")
        .then((res) => setLiveWallets(res.wallets))
        .catch(() => {
          // Soft-fail: stale display is preferable to throwing
          // inside a top-level shell component.
        });
    }
    window.addEventListener(WALLET_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(WALLET_CHANGED_EVENT, refresh);
  }, []);

  const activeWallet = liveWallets?.find((w) => w.currency === activeCurrency);
  const balanceText = activeWallet
    ? fromMicro(BigInt(activeWallet.availableMicro))
    : "0";
  const isDemo = activeCurrency === "OZ";

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click + Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }} className="oz-topbar-wallet">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch wallet"
        style={pillStyle}
      >
        <I.Wallet size={14} style={{ color: "var(--fg-muted)" }} />
        <span className="mono tnum" style={{ fontSize: 13, fontWeight: 600 }}>
          {balanceText}
        </span>
        <span
          className="mono oz-topbar-wallet-unit"
          style={{ fontSize: 11, color: "var(--fg-muted)" }}
        >
          {activeCurrency}
        </span>
        {isDemo ? (
          <span
            className="oz-topbar-wallet-deposit"
            style={{
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 600,
              background: "var(--surface)",
              color: "var(--fg-muted)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Demo
          </span>
        ) : (
          <span
            className="oz-topbar-wallet-deposit"
            style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
          >
            <Divider v style={{ height: 18, margin: "0 2px" }} />
            <I.Chev size={12} style={{ color: "var(--fg-muted)" }} />
          </span>
        )}
      </button>

      {open ? (
        <CurrencyPopover
          wallets={liveWallets ?? []}
          activeCurrency={activeCurrency}
          onPick={(c) => {
            slip.setCurrency(c);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function CurrencyPopover({
  wallets,
  activeCurrency,
  onPick,
  onClose,
}: {
  wallets: WalletSnapshot[];
  activeCurrency: Currency;
  onPick: (c: Currency) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      style={{
        position: "absolute",
        top: PILL_HEIGHT + 6,
        right: 0,
        minWidth: 220,
        padding: 6,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {wallets.length === 0 ? (
        <p style={{ padding: "10px 12px", fontSize: 12, color: "var(--fg-muted)" }}>
          No wallets available.
        </p>
      ) : (
        wallets.map((w) => (
          <CurrencyRow
            key={w.currency}
            wallet={w}
            active={w.currency === activeCurrency}
            onPick={onPick}
          />
        ))
      )}

      <div
        style={{
          marginTop: 4,
          paddingTop: 6,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <Link
          href="/wallet"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 8,
            textDecoration: "none",
            color: "var(--fg-muted)",
            fontSize: 12,
          }}
        >
          <span>Open wallet</span>
          <span aria-hidden style={{ fontSize: 14 }}>
            →
          </span>
        </Link>
      </div>
    </div>
  );
}

function CurrencyRow({
  wallet,
  active,
  onPick,
}: {
  wallet: WalletSnapshot;
  active: boolean;
  onPick: (c: Currency) => void;
}) {
  const balance = fromMicro(BigInt(wallet.availableMicro));
  const isDemo = wallet.currency === "OZ";
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={() => onPick(wallet.currency)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 12px",
        background: active ? "var(--surface-2)" : "transparent",
        border: 0,
        borderRadius: 8,
        textAlign: "left",
        font: "inherit",
        color: "var(--fg)",
        cursor: "pointer",
        width: "100%",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
          {wallet.currency}
        </span>
        {isDemo ? (
          <span
            style={{
              padding: "1px 6px",
              fontSize: 9,
              fontWeight: 600,
              background: "var(--surface-2)",
              color: "var(--fg-muted)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Demo
          </span>
        ) : null}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--fg)" : "var(--fg-muted)",
        }}
      >
        {balance}
      </span>
    </button>
  );
}
