import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";
import { isAdminHost } from "@/lib/host";
import { Monogram } from "@/components/ui/monogram";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  if (await isAdminHost()) notFound();

  const claims = await getSessionClaims();
  if (claims) {
    redirect("/account");
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
        Create your account.
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        Takes 30 seconds. Deposit to start betting.
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
        Already have an account?{" "}
        <Link href="/login" style={{ color: "var(--fg)", textDecoration: "underline" }}>
          Log in
        </Link>
      </div>
    </>
  );
}
