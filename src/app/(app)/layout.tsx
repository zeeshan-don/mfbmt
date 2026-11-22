import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SideNav, MobileNav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Badge } from "@/components/ui";
import { isDemoMode } from "@/lib/env";
import { workerLiveness } from "@/lib/workflow/jobs";
import { LogOut } from "lucide-react";
import { logoutAction } from "../logout-action";

export const dynamic = "force-dynamic";

async function SystemStatus() {
  const worker = await workerLiveness();
  if (worker.status === "HEALTHY") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
        Worker active
        <span className="text-muted">
          · checked {worker.lastSeenAt?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </span>
    );
  }
  if (worker.status === "STALE") {
    return (
      <span className="inline-flex items-center gap-1.5 text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
        Worker not responding
        <span className="text-muted">
          · last seen {worker.lastSeenAt ? worker.lastSeenAt.toLocaleString("en-GB") : "never"}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-line" aria-hidden />
      Worker status unknown — start the worker
    </span>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [organization, unread] = await Promise.all([
    db.organization.findUnique({ where: { id: user.organizationId } }),
    db.notification.count({ where: { isRead: false, ...(user.role === "OWNER" ? {} : { userId: user.id }) } }),
  ]);

  return (
    <div className="flex min-h-screen bg-bg">
      <RealtimeRefresh organizationId={user.organizationId} />
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <Link href="/" className="mb-6 block px-2">
          <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            {organization?.name ?? "Procurement"}
          </span>
          <span className="mt-1 block text-[13px] font-medium leading-tight text-ink">
            Procurement
            <br />
            Intelligence
          </span>
          <span className="mt-1 block text-[10px] text-muted">Workspace: {user.organizationSlug}</span>
        </Link>
        <SideNav role={user.role} isDemo={isDemoMode} />
        <div className="mt-auto space-y-2 px-2 pt-6">
          {isDemoMode ? <Badge tone="warn">Demo mode — sample data</Badge> : null}
          <p className="text-[11px] leading-relaxed text-muted">
            Every supplier price shows where it came from. Nothing is purchased automatically.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <Link href="/" className="max-w-[9rem] shrink-0 truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
                {organization?.name ?? "Procurement"}
              </Link>
              <MobileNav role={user.role} isDemo={isDemoMode} />
            </div>
            <div className="hidden items-center gap-2 text-xs text-muted lg:flex">
              <SystemStatus />
              <span className="text-line">·</span>
              {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/activity#notifications"
                className="relative inline-flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-xs text-soft hover:bg-elevated hover:text-ink"
              >
                Alerts
                {unread > 0 ? (
                  <span className="ml-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white tabular">
                    {unread}
                  </span>
                ) : null}
              </Link>
              <ThemeToggle />
              <div className="flex items-center gap-2 border-l border-line pl-2 sm:pl-3">
                <Link href="/account" className="hidden text-right leading-tight hover:text-accent sm:block">
                  <p className="text-xs font-medium text-ink">{user.name}</p>
                  <p className="text-[11px] text-muted">{user.role === "OWNER" ? "Owner" : "Staff"}</p>
                </Link>
                <form action={logoutAction}>
                  <button
                    type="submit"
                    aria-label="Sign out"
                    title="Sign out"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-control border border-line bg-surface text-soft hover:bg-elevated hover:text-ink"
                  >
                    <LogOut size={14} aria-hidden />
                  </button>
                </form>
              </div>
            </div>
          </div>
          <div className="border-t border-line px-4 py-1 text-[11px] text-muted lg:hidden">
            <SystemStatus />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
