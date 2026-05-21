import Link from "next/link";
import { getTranslations } from "@/lib/i18n/server";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage() {
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
        {t("forgotTitle")}
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        {t("forgotSubtitle")}
      </p>

      <ForgotPasswordForm />

      <div
        style={{
          marginTop: 24,
          fontSize: 13,
          color: "var(--fg-muted)",
          textAlign: "center",
        }}
      >
        <Link href="/login" style={{ color: "var(--fg)", textDecoration: "underline" }}>
          {t("forgotBackToLogin")}
        </Link>
      </div>
    </>
  );
}
