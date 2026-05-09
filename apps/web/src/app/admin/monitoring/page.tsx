import { MonitoringDashboard } from "./dashboard";

export const metadata = {
  title: "Performance — Oddzilla Admin",
};

// The page itself is server-rendered (so the role guard in the admin
// layout runs before any data fetch), but the actual content is a
// client component that polls /admin/monitoring/snapshot every few
// seconds. Server-fetching once would just stale-out under refresh.
export default function MonitoringPage() {
  return <MonitoringDashboard />;
}
