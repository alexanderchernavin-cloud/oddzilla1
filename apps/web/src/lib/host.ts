import "server-only";
import { headers } from "next/headers";

function normalize(host: string | null | undefined): string | null {
  if (!host) return null;
  return host.split(":")[0]!.toLowerCase();
}

export async function isAdminHost(): Promise<boolean> {
  const configured = normalize(process.env.ADMIN_HOST);
  if (!configured) return false;
  const h = await headers();
  const current = normalize(h.get("x-forwarded-host") ?? h.get("host"));
  return current === configured;
}
