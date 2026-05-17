import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import type { ZillapassMeResponse } from "@oddzilla/types";
import { ZillapassPageView } from "./zillapass-view";

export default async function ZillapassPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/zillapass");

  const initial = await serverApi<ZillapassMeResponse>("/zillapass/me");

  return (
    <div style={{ paddingTop: 56 /* clear the sticky search row above */ }}>
      <ZillapassPageView initial={initial} />
    </div>
  );
}
