import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SideNav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui";
import { isDemoMode } from "@/lib/env";
import { LogOut } from "lucide-react";
import { logoutAction } from "../logout-action";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await db.notification.count({ where: { isRead: false, ...(user.role === "OWNER" ? {} : { userId: user.id }) } });

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <Link href="/" className="mb-6 block px-2">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">MFBMT</span>
          <span className="mt-1 block text-[13px] font-medium leading-tight text-ink">
            Procurement
            <br />
            Intelligence
          </span>
        </Link>
        <SideNav />
        <div className="mt-auto space-y-2 px-2 pt-6">
          {isDemoMode ? <Badge tone="warn">Demo mode</Badge> : null}
          <p className="text-[11px] leading-relaxed text-muted">
            Every supplier price shows where it came from. Nothing is purchased automatically.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3 lg:hidden">
            <Link href="/" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
              MFBMT
            </Link>
            <nav className="flex gap-1 overflow-x-auto text-xs">
              <Link href="/enquiries" className="rounded px-2 py-1 text-soft hover:bg-elevated">Enquiries</Link>
              <Link href="/sourcing" className="rounded px-2 py-1 text-soft hover:bg-elevated">Sourcing</Link>
              <Link href="/approvals" className="rounded px-2 py-1 text-soft hover:bg-elevated">Approvals</Link>
              <Link href="/inventory" className="rounded px-2 py-1 text-soft hover:bg-elevated">Stock</Link>
              <Link href="/settings" className="rounded px-2 py-1 text-soft hover:bg-elevated">Settings</Link>
            </nav>
          </div>
          <div className="hidden items-center gap-2 text-xs text-muted lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
            System running
            <span className="text-line">·</span>
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/activity#notifications"
              className="relative inline-flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-xs text-soft hover:bg-elevated hover:text-ink"
            >
              Notifications
              {unread > 0 ? (
                <span className="ml-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white tabular">
                  {unread}
                </span>
              ) : null}
            </Link>
            <ThemeToggle />
            <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
              <div className="text-right leading-tight">
                <p className="text-xs font-medium text-ink">{user.name}</p>
                <p className="text-[11px] text-muted">{user.role === "OWNER" ? "Owner" : "Staff"}</p>
              </div>
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
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
