import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { isAdminHost } from "@/lib/host";
import { Monogram } from "@/components/ui/monogram";
import { getTranslations } from "@/lib/i18n/server";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  if (await isAdminHost()) notFound();

  const user = await getSessionUser();
  if (user) {
    redirect("/account");
  }
  const t = await getTranslations("auth");

  return (
    <>
      <Monogram size={120} />
      <h1
        className="display"
        style={{
          margin: "20px 0 6px",
          fontSize: 28,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        {t("signupTitle")}
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        {t("signupSubtitle")}
      </p>

      <SignupForm />

      <div
        style={{
          marginTop: 24,
          fontSize: 13,
          color: "var(--fg-muted)",
          textAlign: "center",
        }}
      >
        {t("haveAccount")}{" "}
        <Link href="/login" style={{ color: "var(--fg)", textDecoration: "underline" }}>
          {t("loginCta")}
        </Link>
      </div>
    </>
  );
}
