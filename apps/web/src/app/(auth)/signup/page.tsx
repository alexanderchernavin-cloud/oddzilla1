import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const claims = await getSessionClaims();
  if (claims) {
    redirect("/account");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Email and a password of at least 8 characters.
      </p>

      <SignupForm />

      <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
        Have an account?{" "}
        <Link href="/login" className="underline decoration-[var(--color-accent)]">
          Log in
        </Link>
        .
      </p>
    </main>
  );
}
