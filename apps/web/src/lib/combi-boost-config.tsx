"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  COMBI_BOOST_DEFAULT_CONFIG,
  type CombiBoostConfigLive,
} from "@oddzilla/types/combi-boost";

// Context wrapper for the live config served by /catalog/combi-boost-config.
// The (main) layout server-fetches it once per request and seeds the
// provider; client components read via useCombiBoostConfig(). Falls back
// to the static defaults from @oddzilla/types when the API call fails so
// the storefront stays usable during a brief outage.

const Ctx = createContext<CombiBoostConfigLive>(COMBI_BOOST_DEFAULT_CONFIG);

export function CombiBoostConfigProvider({
  config,
  children,
}: {
  config: CombiBoostConfigLive;
  children: ReactNode;
}) {
  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}

export function useCombiBoostConfig(): CombiBoostConfigLive {
  return useContext(Ctx);
}
