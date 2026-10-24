"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/format";
import { useAccessArgs } from "./access";
import { DELIVERY } from "./approvals";
import { ChooseMemberNotice, useFamilyAction } from "./family";
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

type Alert = FunctionReturnType<typeof api.dashboard.alerts>[number];

const TYPE: Record<
  Alert["type"],
  { label: string; tone: Tone; urgent: boolean }
> = {
  scam: { label: "Possible scam", tone: "danger", urgent: true },
  wellbeing: { label: "Wellbeing", tone: "danger", urgent: true },
  approval_needed: { label: "Approval needed", tone: "warn", urgent: false },
  payment_failed: { label: "Payment failed", tone: "warn", urgent: false },
  order_placed: { label: "Order placed", tone: "good", urgent: false },
  connect_nudge: { label: "Give them a call", tone: "info", urgent: false },
};

type Filter = "open" | "all";

export function Alerts() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const alerts = useQuery(api.dashboard.alerts, args);
  const [filter, setFilter] = useState<Filter>("open");
  const tz = household?.timezone;
  const open = alerts?.filter((a) => a.acknowledgedAt === null) ?? [];
  const shown = filter === "open" ? open : (alerts ?? []);
  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Scam and wellbeing alerts are always shared, whatever the privacy settings."
        aside={
          <div
            role="group"
            aria-label="Show"
            className="flex gap-1 rounded-xl border border-line bg-surface p-1"
          >
            {(["open", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-4 py-1.5 text-lg font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40 ${
                  filter === f
                    ? "bg-accent text-on-accent"
                    : "text-ink hover:bg-surface-2"
                }`}
              >
                {f === "open" ? `To review (${open.length})` : "All"}
              </button>
            ))}
          </div>
        }
      />
      {alerts === undefined ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>
          {filter === "open"
            ? "You're all caught up. Nothing new to review."
            : "No alerts yet."}
        </Empty>
      ) : (
        <ul className="space-y-4">
          {shown.map((alert) => (
            <li key={alert._id}>
              <AlertCard alert={alert} timezone={tz} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AlertCard({ alert, timezone }: { alert: Alert; timezone?: string }) {
  const type = TYPE[alert.type];
  const ack = useFamilyAction(api.alerts.acknowledge);
  const acknowledged = alert.acknowledgedAt !== null;
  const border =
    type.urgent && !acknowledged
      ? type.tone === "danger"
        ? "border-l-8 border-l-danger"
        : "border-l-8 border-l-warn"
      : "";
  return (
    <Card className={`${border} ${acknowledged ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={type.tone} className="text-lg">
            {type.label}
          </Badge>
          {alert.channel === "call" && (
            <Badge tone={DELIVERY[alert.delivery].tone}>
              Call to {alert.recipient} · {DELIVERY[alert.delivery].label}
            </Badge>
          )}
          {alert.decision && (
            <Badge tone={alert.decision === "approved" ? "good" : "neutral"}>
              {alert.decision === "approved" ? "Approved" : "Declined"}
              {alert.decidedBy && ` by ${alert.decidedBy}`}
            </Badge>
          )}
        </div>
        <time
          className="text-base text-muted"
          dateTime={new Date(alert.sentAt).toISOString()}
        >
          {formatDateTime(alert.sentAt, timezone)}
        </time>
      </div>
      <p className="mt-3 text-xl leading-relaxed break-words">
        {alert.message}
      </p>
      {alert.transcriptExcerpt && (
        <figure className="mt-3">
          <figcaption className="text-base font-semibold text-muted">
            From the call
          </figcaption>
          <blockquote className="mt-1 whitespace-pre-line rounded-lg border-l-4 border-danger/50 bg-surface-2 px-4 py-3 text-lg break-words">
            {alert.transcriptExcerpt}
          </blockquote>
        </figure>
      )}
      {alert.scamCall && <ScamHold alert={alert} timezone={timezone} />}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {acknowledged ? (
          <p className="text-base text-muted">
            ✓ Seen{alert.acknowledgedBy && ` by ${alert.acknowledgedBy}`}
            {alert.acknowledgedAt !== null &&
              ` · ${formatDateTime(alert.acknowledgedAt, timezone)}`}
          </p>
        ) : ack.ready ? (
          <Button
            variant="primary"
            disabled={ack.pending}
            onClick={() => ack.call({ alertId: alert._id })}
          >
            {ack.pending ? "Saving…" : "Mark as seen"}
          </Button>
        ) : (
          <ChooseMemberNotice />
        )}
      </div>
      <ErrorText>{ack.error}</ErrorText>
    </Card>
  );
}

/** SCM-6: lift a scam hold. The hard rule (gift cards, wires, crypto) still blocks. */
function ScamHold({ alert, timezone }: { alert: Alert; timezone?: string }) {
  const call = alert.scamCall!;
  const override = useFamilyAction(api.orders.overrideScamHold);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-4">
      <p className="text-lg">
        <span className="font-semibold">Purchases on this call: </span>
        {call.holdActive ? (
          <Badge tone="danger">On hold</Badge>
        ) : (
          <Badge tone="neutral">Not on hold</Badge>
        )}
        {!call.live && (
          <span className="ml-2 text-base text-muted">(call has ended)</span>
        )}
      </p>
      {call.holdActive && call.holdReason && (
        <p className="mt-1 text-base text-muted">{call.holdReason}</p>
      )}
      {call.overrides.length > 0 && (
        <ul className="mt-3 space-y-1 text-base" aria-label="Override history">
          {call.overrides.map((o, i) => (
            <li key={i}>
              <span className="font-semibold">Hold lifted by {o.by}</span>{" "}
              <span className="text-muted">
                · {formatDateTime(o.at, timezone)}
                {o.note && ` · “${o.note}”`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {call.holdActive &&
        (!override.ready ? (
          <div className="mt-3">
            <ChooseMemberNotice />
          </div>
        ) : confirming ? (
          <div className="mt-3 space-y-3">
            <p className="text-lg">
              Lifting the hold lets Errand Line place ordinary orders on this
              call again, within the usual limits.{" "}
              <strong>
                Gift cards, prepaid cards, money transfers and crypto stay
                blocked no matter what.
              </strong>{" "}
              Your name is recorded.
            </p>
            <label
              className="block text-base font-semibold"
              htmlFor={`note-${alert._id}`}
            >
              Why? (optional)
            </label>
            <input
              id={`note-${alert._id}`}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
            />
            <div className="flex flex-wrap gap-3">
              <Button
                variant="danger"
                disabled={override.pending}
                onClick={async () => {
                  const done = await override.call({
                    callId: alert.callId!,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  if (done) setConfirming(false);
                }}
              >
                {override.pending ? "Lifting…" : "Yes, lift the hold"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Keep it on hold
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-3" onClick={() => setConfirming(true)}>
            Override the hold…
          </Button>
        ))}
      <ErrorText>{override.error}</ErrorText>
    </div>
  );
}
