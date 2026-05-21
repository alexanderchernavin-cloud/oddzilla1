// Landing for the verify-email link. We render a client island that
// consumes the `?token=…` query param and POSTs it to
// /auth/verify-email. SSR would also work, but client-side has the
// nice property that the success state can offer a "back to site"
// link with router.refresh() so the banner disappears immediately.

import { VerifyEmailClient } from "./verify-email-client";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  return <VerifyEmailClient token={params.token ?? null} />;
}
