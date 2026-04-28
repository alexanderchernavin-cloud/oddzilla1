import { serverApi } from "@/lib/server-fetch";
import {
  CashoutEditor,
  type CashoutConfigEntry,
  type CashoutOptions,
} from "./cashout-editor";

interface ConfigResponse {
  entries: CashoutConfigEntry[];
}

export default async function AdminCashoutPage() {
  const [entriesRes, optionsRes] = await Promise.all([
    serverApi<ConfigResponse>("/admin/cashout-config"),
    serverApi<CashoutOptions>("/admin/cashout-config/options"),
  ]);

  const entries = entriesRes?.entries ?? [];
  const options: CashoutOptions = optionsRes ?? { sports: [], tournaments: [] };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Cashout</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Per-scope cashout settings. Cascade: market type → tournament → sport
        → global. The most-restrictive resolved value wins across legs of a
        combo (AND on enabled, MIN on prematch full-stake window, MAX on
        minimum offer + change threshold).
      </p>
      <CashoutEditor initialEntries={entries} options={options} />
    </div>
  );
}
