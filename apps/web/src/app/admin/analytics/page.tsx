import { AnalyticsOverview } from "./overview";

export const metadata = {
  title: "Analytics — Oddzilla Admin",
};

// Server-rendered shell (so the role guard in the admin layout runs
// first); the content is a client component that fetches
// /admin/analytics/overview + /admin/analytics/sessions.
export default function AdminAnalyticsPage() {
  return <AnalyticsOverview />;
}
