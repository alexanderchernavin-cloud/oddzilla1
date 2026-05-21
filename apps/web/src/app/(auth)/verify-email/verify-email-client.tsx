"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";
import { useTranslations } from "@/lib/i18n";

type State =
  | { kind: "missing" }
  | { kind: "verifying" }
  | { kind: "ok" }
  | { kind: "error"; code: string };

export function VerifyEmailClient({ token }: { token: string | null }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [state, setState] = useState<State>(() =>
    token ? { kind: "verifying" } : { kind: "missing" },
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        await clientApi("/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        setState({ kind: "ok" });
        // Refresh the SSR shell so the banner clears on next render
        // if the user is signed in.
        router.refresh();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFetchError) {
          setState({ kind: "error", code: err.body.error ?? "verify_failed" });
        } else {
          setState({ kind: "error", code: "network" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  const heading =
    state.kind === "verifying"
      ? t("verifyChecking")
      : state.kind === "ok"
        ? t("verifySuccess")
        : t("verifyTitle");

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
        {heading}
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        {bodyFor(state, t)}
      </p>

      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
        {state.kind === "ok" && (
          <Link href="/" style={{ width: "100%" }}>
            <Button variant="primary" size="lg" type="button" style={{ width: "100%" }}>
              {t("verifyOpenAccount")}
            </Button>
          </Link>
        )}
        {state.kind === "error" && (
          <Link href="/login" style={{ width: "100%" }}>
            <Button variant="primary" size="lg" type="button" style={{ width: "100%" }}>
              {t("loginCta")}
            </Button>
          </Link>
        )}
      </div>
    </>
  );
}

function bodyFor(state: State, t: ReturnType<typeof useTranslations<"auth">>): string {
  switch (state.kind) {
    case "missing":
      return t("verifyMissingToken");
    case "verifying":
      return t("verifyChecking");
    case "ok":
      return t("verifySuccessBody");
    case "error":
      if (state.code === "token_expired") return t("verifyExpired");
      if (state.code === "invalid_token" || state.code === "token_already_used") {
        return t("verifyInvalid");
      }
      return t("errorNetwork");
  }
}
