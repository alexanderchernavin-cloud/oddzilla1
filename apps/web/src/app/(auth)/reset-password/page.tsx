import { ResetPasswordClient } from "./reset-password-client";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  return <ResetPasswordClient token={params.token ?? null} />;
}
