import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AdminSidebar } from "./admin-sidebar";

// The middleware already checks for auth cookie presence before this runs.
// Here we verify the role via the API's /auth/me endpoint (no shared
// JWT_SECRET in the web container — see lib/auth.ts).
//
// Two failure modes to distinguish:
//   - user === null: cookies are missing/invalid (expired, revoked,
//     malformed). Treat that like "not signed in" and bounce to /login —
//     otherwise admins see a bare 404 with a stale cookie they can't
//     clear without DevTools.
//   - user.role !== "admin": real non-admin trying to peek. 404 (not 403)
//     so we don't leak that admin URLs exist.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "admin") notFound();

  return (
    <div className="flex min-h-dvh">
      <AdminSidebar />
      <main className="flex-1 min-w-0 px-6 py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
