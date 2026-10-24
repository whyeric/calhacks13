"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { formatCents, formatDateTime } from "@/lib/format";
import { useAccessArgs } from "./access";
import { ChooseMemberNotice, useFamilyAction } from "./family";
import { ORDER_STATUS } from "./orders";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  PageHeader,
  type Tone,
} from "./ui";

type Result = FunctionReturnType<typeof api.dashboard.approvals>;
type Approval = Result["pending"][number];
type AlertCall = Approval["alertCalls"][number];

export const DELIVERY: Record<
  AlertCall["delivery"],
  { label: string; tone: Tone }
> = {
  queued: { label: "Calling…", tone: "info" },
  ringing: { label: "Ringing", tone: "info" },
  answered: { label: "Answered", tone: "good" },
  no_answer: { label: "No answer", tone: "warn" },
  sent: { label: "Sent", tone: "neutral" },
  failed: { label: "Call failed", tone: "danger" },
};

export function Approvals() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const result = useQuery(api.dashboard.approvals, args);
  const tz = household?.timezone;
  const name = household?.preferredName ?? "the caller";
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={`Orders over a family limit wait here. The first answer, here or on the family alert call, wins.`}
      />
      {result === undefined ? (
        <Loading />
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="waiting">
            <h2 id="waiting" className="mb-3 text-2xl font-bold">
              Waiting for you
            </h2>
            {result.pending.length === 0 ? (
              <Empty>
                Nothing to approve. Orders within the limits go straight
                through.
              </Empty>
            ) : (
              <ul className="space-y-4">
                {result.pending.map((a) => (
                  <li key={a._id}>
                    <PendingCard approval={a} timezone={tz} name={name} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="decided">
            <h2 id="decided" className="mb-3 text-2xl font-bold">
              Recent decisions
            </h2>
            {result.resolved.length === 0 ? (
              <Empty>No decisions yet.</Empty>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {result.resolved.map((a) => (
                    <ResolvedRow key={a._id} approval={a} timezone={tz} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Items({ approval }: { approval: Approval }) {
  return (
    <ul className="mt-3 space-y-1 text-lg">
      {approval.items.map((item, i) => (
        <li key={`${item.name}-${i}`} className="flex justify-between gap-4">
          <span className="min-w-0 break-words">
            {item.qty > 1 && (
              <span className="font-semibold">{item.qty} × </span>
            )}
            {item.name}
          </span>
          <span className="tabular-nums text-muted">
            {formatCents(item.priceCents * item.qty)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AlertCalls({ calls }: { calls: AlertCall[] }) {
  if (calls.length === 0) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-base text-muted">
      <span>Alert call:</span>
      {calls.map((c) => (
        <Badge key={c._id} tone={DELIVERY[c.delivery].tone}>
          {c.recipient} · {DELIVERY[c.delivery].label}
          {c.decision && ` · said ${c.decision === "approved" ? "yes" : "no"}`}
        </Badge>
      ))}
    </p>
  );
}

function PendingCard({
  approval,
  timezone,
  name,
}: {
  approval: Approval;
  timezone?: string;
  name: string;
}) {
  const approve = useFamilyAction(api.orders.familyApprove);
  const decline = useFamilyAction(api.orders.familyDecline);
  const busy = approve.pending || decline.pending;
  return (
    <Card className="border-2 border-warn/60">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-4xl font-bold tabular-nums">
            {formatCents(approval.totalCents)}
          </p>
          <p className="mt-1 text-lg text-muted">
            {approval.store} · asked{" "}
            {formatDateTime(approval.createdAt, timezone)}
          </p>
        </div>
        <Badge tone="warn" className="text-lg">
          Waiting for approval
        </Badge>
      </div>
      {approval.reason && (
        <p className="mt-4 rounded-lg bg-warn-soft px-4 py-3 text-lg text-warn">
          <span className="font-semibold">Limit: </span>
          {approval.reason}
        </p>
      )}
      <Items approval={approval} />
      <AlertCalls calls={approval.alertCalls} />
      <div className="mt-5">
        {!approve.ready ? (
          <ChooseMemberNotice />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={() => approve.call({ orderId: approval._id })}
            >
              {approve.pending ? "Approving…" : "Approve"}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => decline.call({ orderId: approval._id })}
            >
              {decline.pending ? "Declining…" : "Decline"}
            </Button>
            <p className="basis-full text-base text-muted">
              Approving pays for the order now and Errand Line tells {name}.
              Nothing is charged if you decline.
            </p>
          </div>
        )}
        <ErrorText>{approve.error ?? decline.error}</ErrorText>
      </div>
    </Card>
  );
}

function ResolvedRow({
  approval,
  timezone,
}: {
  approval: Approval;
  timezone?: string;
}) {
  const status = ORDER_STATUS[approval.status];
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold">
          {formatCents(approval.totalCents)}{" "}
          <span className="font-normal text-muted">
            · {approval.store} ·{" "}
            {approval.items
              .map((i) => (i.qty > 1 ? `${i.qty} × ${i.name}` : i.name))
              .join(", ")}
          </span>
        </p>
        <p className="mt-1 text-base text-muted">
          {approval.decision === "approved" ? "Approved" : "Declined"} by{" "}
          <span className="font-semibold text-ink">{approval.decidedBy}</span>
          {approval.decidedAt != null &&
            ` · ${formatDateTime(approval.decidedAt, timezone)}`}
        </p>
        <AlertCalls calls={approval.alertCalls} />
      </div>
      <Badge tone={status.tone}>{status.label}</Badge>
    </li>
  );
}
