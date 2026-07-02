import { SessionDetail } from "./session-detail";

export const metadata = {
  title: "Session journey — Oddzilla Admin",
};

export default async function AdminAnalyticsSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionDetail id={id} />;
}
