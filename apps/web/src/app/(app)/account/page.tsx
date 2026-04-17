import { getSessionUser } from "@/lib/auth";
import { AccountForms } from "./account-forms";

export default async function AccountPage() {
  const user = await getSessionUser();
  if (!user) return null; // layout will have redirected

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Manage your profile and password.
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <dl className="card p-6 sm:col-span-3 grid gap-3 sm:grid-cols-3">
          <Field label="Email" value={user.email} />
          <Field label="Role" value={user.role} />
          <Field label="KYC status" value={user.kycStatus} />
        </dl>
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
