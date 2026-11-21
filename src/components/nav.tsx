"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  LayoutDashboard,
  Inbox,
  Radar,
  Boxes,
  Building2,
  BadgeCheck,
  Activity,
  Settings,
  UserRound,
  PlayCircle,
  PlugZap,
  BarChart3,
  Send,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  ownerOnly?: boolean;
  demoOnly?: boolean;
};

const items: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/enquiries", label: "Enquiries", icon: Inbox },
  { href: "/sourcing", label: "Sourcing", icon: Radar },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/customers", label: "Customers", icon: UserRound },
  { href: "/suppliers", label: "Suppliers", icon: Building2 },
  { href: "/suppliers/outreach", label: "Draft RFQs", icon: Send, ownerOnly: true },
  { href: "/approvals", label: "Approvals", icon: BadgeCheck, ownerOnly: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/usage", label: "Usage & cost", icon: BarChart3, ownerOnly: true },
  { href: "/reports", label: "Reports", icon: BarChart3, ownerOnly: true },
  { href: "/integrations", label: "Integrations", icon: PlugZap, ownerOnly: true },
  { href: "/settings", label: "Settings", icon: Settings, ownerOnly: true },
  { href: "/account", label: "My account", icon: UserRound },
  { href: "/demo", label: "Demo walkthrough", icon: PlayCircle, demoOnly: true, ownerOnly: true },
];

export function visibleNavItems(role: string, isDemo = false) {
  return items.filter(
    (item) => (!item.ownerOnly || role === "OWNER") && (!item.demoOnly || isDemo),
  );
}

export function MobileNav({ role, isDemo = false }: { role: string; isDemo?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto text-xs">
      {visibleNavItems(role, isDemo).map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "shrink-0 rounded px-2 py-1.5",
              active ? "bg-elevated font-medium text-ink" : "text-soft hover:bg-elevated hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SideNav({ role, isDemo = false }: { role: string; isDemo?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {visibleNavItems(role, isDemo).map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex items-center gap-2.5 rounded-control px-2.5 py-2 text-sm transition-colors",
              active
                ? "halo bg-elevated font-medium text-ink"
                : "text-soft hover:bg-elevated hover:text-ink",
            )}
          >
            <Icon size={16} aria-hidden className={active ? "text-accent" : "text-muted"} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
