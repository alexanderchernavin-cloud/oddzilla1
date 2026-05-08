import { CompetitionCreateForm } from "./create-form";

export const dynamic = "force-dynamic";

export default function NewCompetitionPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">New competition</h1>
      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
        Create a draft. You can edit details before publishing.
      </p>
      <div className="mt-6">
        <CompetitionCreateForm />
      </div>
    </div>
  );
}
