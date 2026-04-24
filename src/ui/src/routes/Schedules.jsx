// §6.11 Schedules — [Target] route. §9.5 explicitly out of scope for v1.
// Render a placeholder; no backend wiring. Present once the Schedules backend lands.
import { AppShell } from "../components/AppShell.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { Icon } from "../components/Icon.jsx";

export function Schedules() {
  return (
    <AppShell route="schedules" title="Schedules">
      <div class="page-wrap">
        <EmptyState
          icon={<Icon name="clock" size={48} />}
          title="Schedules are coming"
          body="Recurring task templates will live here. Each fire spawns a normal task instance. Pending backend work."
        />
      </div>
    </AppShell>
  );
}
