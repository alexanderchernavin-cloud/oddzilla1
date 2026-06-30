import { getSessionUser } from "@/lib/auth";
import { LogosBrowser } from "./logos-browser";

// Authenticated team-logo browser. The (main) layout + middleware already
// redirect logged-out visitors to /login; the check below is defensive.
export default async function LogosPage() {
  const user = await getSessionUser();
  if (!user) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team logos</h1>
        <p
          style={{
            fontSize: 13.5,
            color: "var(--fg-muted)",
            marginTop: 4,
          }}
        >
          Browse the logo library by sport, category, and league.
        </p>
      </div>
      <LogosBrowser />
    </div>
  );
}
