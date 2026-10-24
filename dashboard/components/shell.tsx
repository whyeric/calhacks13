"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { useAccess, useAccessArgs } from "./access";
import { QueryBoundary } from "./query-boundary";
import { FamilyMemberPicker } from "./family";

const NAV = [
  { href: "/live", label: "Live calls" },
  { href: "/orders", label: "Orders" },
  { href: "/alerts", label: "Alerts", badge: "alerts" },
  { href: "/approvals", label: "Approvals", badge: "approvals" },
  { href: "/memory", label: "Memory" },
  { href: "/settings", label: "Settings" },
  { href: "/developer", label: "Developer" },
] as const;

function HouseholdName() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  return (
    <span className="text-muted">
      {household ? `${household.preferredName}'s line` : " "}
    </span>
  );
}

type Badge = "alerts" | "approvals";

/** Live count on a nav item; isolated so a failing count never hides the menu. */
function NavCount({ badge, active }: { badge: Badge; active: boolean }) {
  const args = useAccessArgs();
  const counts = useQuery(api.dashboard.counts, args);
  if (!counts) return null;
  const count =
    badge === "alerts" ? counts.unacknowledgedAlerts : counts.openApprovals;
  if (count === 0) return null;
  return (
    <span
      className={`rounded-full px-2 text-base tabular-nums ${
        active ? "bg-on-accent text-accent" : "bg-danger text-canvas"
      }`}
    >
      {count}
      <span className="sr-only">
        {badge === "alerts" ? " unacknowledged" : " waiting"}
      </span>
    </span>
  );
}

function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 px-1 pb-2 pt-1">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-lg font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40 ${
                  active
                    ? "bg-accent text-on-accent"
                    : "text-ink hover:bg-surface-2"
                }`}
              >
                {item.label}
                {"badge" in item && (
                  <QueryBoundary fallback={null}>
                    <NavCount badge={item.badge} active={active} />
                  </QueryBoundary>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { forget } = useAccess();
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-20 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-on-accent"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6">
          <div className="mb-2 flex items-center justify-between gap-4">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xl">
              <span className="font-bold text-accent">Errand Line</span>
              <QueryBoundary fallback={null}>
                <HouseholdName />
              </QueryBoundary>
            </div>
            <div className="flex items-center gap-2">
              <QueryBoundary fallback={null}>
                <div className="hidden sm:block">
                  <FamilyMemberPicker compact />
                </div>
              </QueryBoundary>
              <button
                type="button"
                onClick={() => forget()}
                title="Forget the access key on this device"
                className="rounded-lg px-3 py-1 text-base text-muted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
              >
                Lock
              </button>
            </div>
          </div>
          <Nav />
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto outline-none max-w-7xl px-4 py-6 sm:px-6 sm:py-8"
      >
        <QueryBoundary key={pathname}>{children}</QueryBoundary>
      </main>
    </div>
  );
}
