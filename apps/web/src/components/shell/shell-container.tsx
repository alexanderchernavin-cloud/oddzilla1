"use client";

// Client wrapper around the main shell <div>. Reads the mobile-drawer
// state and exposes it as data attributes the CSS can hook into
// (`data-sidebar-open`, `data-rail-open`) without forcing every shell
// child to subscribe. All rendering decisions live in globals.css.

import type { ReactNode } from "react";
import { useMobileDrawers } from "./mobile-drawer-context";

export function ShellContainer({ children }: { children: ReactNode }) {
  const { sidebarOpen, railOpen } = useMobileDrawers();
  return (
    <div
      className="oz-shell"
      data-sidebar-open={sidebarOpen ? "true" : "false"}
      data-rail-open={railOpen ? "true" : "false"}
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {children}
    </div>
  );
}
