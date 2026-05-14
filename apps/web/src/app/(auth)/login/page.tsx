import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser, safeNextPath } from "@/lib/auth";
import { isAdminHost } from "@/lib/host";
import { getTranslations } from "@/lib/i18n/server";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getSessionUser();
  const params = await searchParams;
  const adminHost = await isAdminHost();
  if (user) {
    redirect(safeNextPath(params.next, adminHost ? "/admin" : "/"));
  }
  const t = await getTranslations("auth");

  return (
    <>
      <h1
        className="display"
        style={{
          margin: "0 0 6px",
          fontSize: 28,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        {t("loginTitle")}
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        {t("loginSubtitle")}
      </p>

      <LoginForm next={safeNextPath(params.next, adminHost ? "/admin" : "/")} />

      {!adminHost && (
        <div
          style={{
            marginTop: 24,
            fontSize: 13,
            color: "var(--fg-muted)",
            textAlign: "center",
          }}
        >
          {t("noAccount")}{" "}
          <Link
            href="/signup"
            style={{ color: "var(--fg)", textDecoration: "underline" }}
          >
            {t("signupCta")}
          </Link>
        </div>
      )}
    </>
  );
}
