import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { CookieBanner } from "@/components/shell/cookie-banner";
import { AuthFooterLink } from "./auth-footer-link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--fg)" }}>
      <header className="oz-auth-header">
        <Link href="/" style={{ textDecoration: "none", color: "var(--fg)" }}>
          <Wordmark size={36} priority />
        </Link>
        <div style={{ flex: 1 }} />
        <ThemeToggle />
      </header>
      <div className="oz-auth-body">
        <div>
          {children}
          <AuthFooterLink />
        </div>
      </div>
      <CookieBanner />
    </div>
  );
}
