import { getSessionUser } from "@/lib/auth";
import { getTranslations } from "@/lib/i18n/server";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { AccountForms } from "./account-forms";

export default async function AccountPage() {
  const user = await getSessionUser();
  if (!user) return null; // layout will have redirected
  const t = await getTranslations("account");
  const tShell = await getTranslations("shell");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        {t("emailChangeNote")}
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <dl className="card p-6 sm:col-span-3 grid gap-3 sm:grid-cols-3">
          <Field label={t("email")} value={user.email} />
          <Field label="Role" value={user.role} />
          <Field label="KYC status" value={user.kycStatus} />
        </dl>
      </section>

      <section className="mt-6 card p-6">
        <h2 className="text-base font-semibold">{tShell("language")}</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {t("language")}
        </p>
        <div className="mt-4">
          <LanguageSwitcher variant="inline" />
        </div>
      </section>

      <AccountForms
        initialDisplayName={user.displayName ?? ""}
        initialCountryCode={user.countryCode ?? ""}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{value}</dd>
    </div>
  );
}
