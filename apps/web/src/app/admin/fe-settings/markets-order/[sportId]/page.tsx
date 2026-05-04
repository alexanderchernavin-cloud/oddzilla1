import { redirect } from "next/navigation";

export default async function SportRoot({
  params,
}: {
  params: Promise<{ sportId: string }>;
}) {
  const { sportId } = await params;
  redirect(`/admin/fe-settings/markets-order/${sportId}/match`);
}
