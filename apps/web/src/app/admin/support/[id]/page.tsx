import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import type { AdminSupportThreadDetail } from "@oddzilla/types";
import { SupportThreadClient } from "./thread-client";

export const dynamic = "force-dynamic";

export default async function AdminSupportThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<AdminSupportThreadDetail>(
    `/admin/support/threads/${id}`,
  );
  if (!data) notFound();

  const counterpart =
    data.thread.userNickname && data.thread.userNickname.length > 0
      ? `${data.thread.userNickname} · ${data.thread.userEmail}`
      : data.thread.userEmail;

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/admin/support"
          className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Back to support
        </Link>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {data.thread.subject ?? "Conversation"}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            With{" "}
            <Link
              href={`/admin/users/${data.thread.userId}`}
              className="text-[var(--color-fg)] underline-offset-2 hover:underline"
            >
              {counterpart}
            </Link>
            {" · "}
            {data.thread.status === "closed" ? "Closed" : "Open"}
          </p>
        </div>
      </div>

      <SupportThreadClient threadId={id} initial={data} />
    </div>
  );
}
