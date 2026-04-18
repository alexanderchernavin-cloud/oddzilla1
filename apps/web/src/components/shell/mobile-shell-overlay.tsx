"use client";

import { useMobileDrawers } from "./mobile-drawer-context";

// Full-screen scrim shown behind an open mobile drawer. Tapping it
// closes whatever's open. Pure presentational — siblings handle their
// own transform animations via CSS.
export function MobileShellOverlay() {
  const { sidebarOpen, railOpen, closeAll } = useMobileDrawers();
  const open = sidebarOpen || railOpen;
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={closeAll}
      className="oz-shell-scrim"
      data-open={open ? "true" : "false"}
      tabIndex={open ? 0 : -1}
    />
  );
}
