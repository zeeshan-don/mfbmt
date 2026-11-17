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
} from "lucide-react";

const items = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/enquiries", label: "Enquiries", icon: Inbox },
  { href: "/sourcing", label: "Sourcing", icon: Radar },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/suppliers", label: "Suppliers", icon: Building2 },
  { href: "/approvals", label: "Approvals", icon: BadgeCheck },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
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
