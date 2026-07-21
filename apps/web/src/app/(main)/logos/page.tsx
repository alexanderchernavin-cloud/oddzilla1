import { getTranslations } from "@/lib/i18n/server";
import { LogosBrowser } from "./logos-browser";

// Public team-logo browser — open to logged-out visitors too (not in the
// middleware PROTECTED_PREFIXES). Logo assets are served publicly by Caddy.
export default async function LogosPage() {
  const t = await getTranslations("logos");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p
          style={{
            fontSize: 13.5,
            color: "var(--fg-muted)",
            marginTop: 4,
          }}
        >
          {t("subtitle")}
        </p>
      </div>
      <LogosBrowser />
    </div>
  );
}
