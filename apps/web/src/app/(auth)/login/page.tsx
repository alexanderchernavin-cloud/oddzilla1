import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const claims = await getSessionClaims();
  const params = await searchParams;
  if (claims) {
    redirect(params.next && params.next.startsWith("/") ? params.next : "/account");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Use the email and password you signed up with.
      </p>

      <LoginForm next={params.next ?? "/account"} />

      <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
        No account?{" "}
        <Link href="/signup" className="underline decoration-[var(--color-accent)]">
          Create one
        </Link>
        .
      </p>
    </main>
  );
}
