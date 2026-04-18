import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "18px 24px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <Link href="/" style={{ textDecoration: "none", color: "var(--fg)" }}>
          <Wordmark size={15} />
        </Link>
        <div style={{ flex: 1 }} />
        <ThemeToggle />
      </header>
      <div
        style={{
          padding: "60px 32px",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          minHeight: "calc(100% - 60px)",
        }}
      >
        <div style={{ width: "100%", maxWidth: 380 }}>{children}</div>
      </div>
    </div>
  );
}
