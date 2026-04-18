import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";
import { Monogram } from "@/components/ui/monogram";
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
    <>
      <Monogram size={36} />
      <h1
        className="display"
        style={{
          margin: "20px 0 6px",
          fontSize: 28,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        Welcome back.
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        Log in to place bets and track your history.
      </p>

      <LoginForm next={params.next ?? "/account"} />

      <div
        style={{
          marginTop: 24,
          fontSize: 13,
          color: "var(--fg-muted)",
          textAlign: "center",
        }}
      >
        No account yet?{" "}
        <Link
          href="/signup"
          style={{ color: "var(--fg)", textDecoration: "underline" }}
        >
          Sign up
        </Link>
      </div>
    </>
  );
}
