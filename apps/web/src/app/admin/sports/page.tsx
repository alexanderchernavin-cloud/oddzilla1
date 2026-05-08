import { serverApi } from "@/lib/server-fetch";
import { SportsEditor, type SportRow } from "./sports-editor";

export const dynamic = "force-dynamic";

interface ListResponse {
  total: number;
  missingLogoCount: number;
  limit: number;
  offset: number;
  sports: SportRow[];
}

export default async function AdminSportsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; missingLogo?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const params = new URLSearchParams();
  if (sp.q) params.set("q", sp.q);
  if (sp.missingLogo === "1" || sp.missingLogo === "true") {
    params.set("missingLogo", "1");
  }
  // Sports list is small (~40 rows including bots); always pull the full
  // set so admins don't need to paginate.
  params.set("limit", "200");

  const data = await serverApi<ListResponse>(`/admin/sports?${params.toString()}`);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sports</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Logo and brand colour for each sport. Either paste an HTTPS URL or
        a self-hosted absolute path (e.g. <code>/sports/cs2.svg</code>),
        or upload a file (SVG, PNG, JPEG, WebP — max 1 MB). Use{" "}
        <strong>Remove logo</strong> to clear an upload or pasted URL.
        Edits propagate to the storefront on the next page load — there&apos;s
        no cache layer in front of <code>/catalog/sports</code>.
      </p>
      {data ? (
        <SportsEditor
          initialList={data}
          currentFilters={{
            q: sp.q ?? "",
            missingLogo: sp.missingLogo === "1" || sp.missingLogo === "true",
          }}
        />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load sports. Reload the page or check the API service status.
        </p>
      )}
    </div>
  );
}
