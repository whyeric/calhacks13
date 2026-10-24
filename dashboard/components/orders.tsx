"use client";

import { useQuery } from "convex/react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
  formatCents,
  formatDateTime,
  monthKey,
  monthLabel,
} from "@/lib/format";
import { useAccessArgs } from "./access";
import {
  Badge,
  Card,
  Empty,
  Loading,
  Meter,
  PageHeader,
  type Tone,
} from "./ui";

type OrdersResult = FunctionReturnType<typeof api.dashboard.orders>;
type Order = OrdersResult["orders"][number];

export const ORDER_STATUS: Record<
  Order["status"],
  { label: string; tone: Tone }
> = {
  pending: { label: "Pending", tone: "info" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  declined: { label: "Declined", tone: "neutral" },
  paid: { label: "Paid", tone: "good" },
  failed: { label: "Payment failed", tone: "danger" },
};

/**
 * Current "YYYY-MM" in the household timezone, re-checked every minute. A
 * string, so the orders subscription only changes when the month does.
 * (Client-only: the dashboard renders behind the access gate, never on the server.)
 */
function useMonth(timezone?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return timezone ? monthKey(now, timezone) : undefined;
}

export function Orders() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const tz = household?.timezone;
  const month = useMonth(tz);
  // Wait for the month so the list subscribes once, with the spend summary.
  const result = useQuery(
    api.dashboard.orders,
    month ? { ...args, month } : "skip",
  );

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Every order Errand Line placed or asked about, newest first."
      />
      <p className="-mt-3 mb-6 text-base text-muted">
        Requests stopped by the scam check never become orders; they show on
        Live calls and Alerts.
      </p>
      {result?.monthly && <MonthlySpend monthly={result.monthly} />}
      {result === undefined ? (
        <Loading />
      ) : result.orders.length === 0 ? (
        <Empty>No orders yet.</Empty>
      ) : (
        <ul className="space-y-4">
          {result.orders.map((order) => (
            <li key={order._id}>
              <OrderCard order={order} timezone={tz} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function MonthlySpend({
  monthly,
}: {
  monthly: NonNullable<OrdersResult["monthly"]>;
}) {
  const budget = monthly.budgetCents;
  const fraction =
    budget === null
      ? 0
      : budget > 0
        ? monthly.spentCents / budget
        : monthly.spentCents > 0
          ? 1
          : 0;
  const tone: Tone =
    fraction >= 1 ? "danger" : fraction >= 0.8 ? "warn" : "good";
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xl font-bold">
          Spent in {monthLabel(monthly.month)}
        </h2>
        <p className="text-2xl font-bold tabular-nums">
          {formatCents(monthly.spentCents)}
          {budget !== null && (
            <span className="text-lg font-normal text-muted">
              {" "}
              of {formatCents(budget)} budget
            </span>
          )}
        </p>
      </div>
      {budget !== null && (
        <div className="mt-3">
          <Meter
            value={fraction}
            label="Monthly spend against budget"
            tone={tone}
          />
          <p className="mt-2 text-base text-muted">
            {monthly.spentCents <= budget
              ? `${formatCents(budget - monthly.spentCents)} left this month`
              : `${formatCents(monthly.spentCents - budget)} over budget`}{" "}
            · {monthly.paidCount} paid{" "}
            {monthly.paidCount === 1 ? "order" : "orders"}
          </p>
        </div>
      )}
    </Card>
  );
}

function OrderCard({ order, timezone }: { order: Order; timezone?: string }) {
  const status = ORDER_STATUS[order.status];
  const showReason =
    order.reason != null &&
    (order.status === "awaiting_approval" || order.status === "failed");
  const details: ReactNode[] = [];
  if (order.approvedBy) details.push(<>Approved by {order.approvedBy}</>);
  if (order.declinedBy) details.push(<>Declined by {order.declinedBy}</>);
  if (order.decidedAt != null && (order.approvedBy || order.declinedBy))
    details.push(<>Decided {formatDateTime(order.decidedAt, timezone)}</>);
  if (order.paidAt != null)
    details.push(<>Paid {formatDateTime(order.paidAt, timezone)}</>);
  if (order.paymentRef) details.push(<>Payment ref …{order.paymentRef}</>);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-3xl font-bold tabular-nums">
            {formatCents(order.totalCents)}
          </p>
          <p className="mt-1 text-lg text-muted">
            {order.store} ·{" "}
            <time dateTime={new Date(order.createdAt).toISOString()}>
              {formatDateTime(order.createdAt, timezone)}
            </time>
          </p>
        </div>
        <Badge tone={status.tone} className="text-lg">
          {status.label}
        </Badge>
      </div>
      {showReason && (
        <p
          className={`mt-4 rounded-lg px-4 py-3 text-lg ${
            order.status === "failed"
              ? "bg-danger-soft text-danger"
              : "bg-warn-soft text-warn"
          }`}
        >
          <span className="font-semibold">
            {order.status === "failed" ? "Why it failed: " : "Needs approval: "}
          </span>
          {order.reason}
        </p>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-lg">
          <caption className="sr-only">Items</caption>
          <thead>
            <tr className="border-b border-line text-left text-base text-muted">
              <th scope="col" className="py-2 font-semibold">
                Item
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">
                Qty
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">
                Each
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, i) => (
              <tr key={`${item.name}-${i}`} className="border-b border-line/60">
                <td className="py-2 pr-3 break-words">{item.name}</td>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {item.qty}
                </td>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {formatCents(item.priceCents)}
                </td>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {formatCents(item.priceCents * item.qty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {details.length > 0 && (
        <p className="mt-3 text-base text-muted">
          {details.map((d, i) => (
            <Fragment key={i}>
              {i > 0 && " · "}
              {d}
            </Fragment>
          ))}
        </p>
      )}
    </Card>
  );
}
