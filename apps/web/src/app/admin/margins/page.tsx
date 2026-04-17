import { serverApi } from "@/lib/server-fetch";
import { MarginsEditor, type MarginEntry, type MarginOptions } from "./margins-editor";

interface MarginsResponse {
  entries: MarginEntry[];
}

export default async function MarginsPage() {
  const [entriesRes, optionsRes] = await Promise.all([
    serverApi<MarginsResponse>("/admin/odds-config"),
    serverApi<MarginOptions>("/admin/odds-config/options"),
  ]);

  const entries = entriesRes?.entries ?? [];
  const options: MarginOptions = optionsRes ?? { sports: [], tournaments: [] };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Payback margins</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Margin applied by odds-publisher before odds reach the client.
        Cascade: market type → tournament → sport → global. Changes take
        effect within ~5 seconds.
      </p>

      <MarginsEditor initialEntries={entries} options={options} />
    </div>
  );
}
