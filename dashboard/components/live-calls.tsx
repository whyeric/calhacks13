"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  formatDateTime,
  formatDuration,
  formatMs,
  formatTime,
  scamFraction,
  scamLevel,
  titleCase,
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

type Live = NonNullable<FunctionReturnType<typeof api.dashboard.liveCall>>;
type Turn = Live["turns"][number];
type CallSummary = Live["call"];

const OUTCOME: Record<CallSummary["outcome"], { label: string; tone: Tone }> = {
  ordered: { label: "Ordered", tone: "good" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  declined_scam: { label: "Scam declined", tone: "danger" },
  no_order: { label: "No order", tone: "neutral" },
  unknown_caller: { label: "Unknown caller", tone: "neutral" },
};

const KIND: Record<CallSummary["kind"], string> = {
  order: "Order call",
  chat: "Chat",
  mixed: "Chat and order",
  unknown_caller: "Unknown caller",
  checkin: "Check-in (outbound)",
};

const LEVEL: Record<
  ReturnType<typeof scamLevel>,
  { label: string; tone: Tone }
> = {
  clear: { label: "Clear", tone: "good" },
  caution: { label: "Caution", tone: "warn" },
  high: { label: "High risk", tone: "danger" },
};

/** A call with no end and no activity for this long was probably never closed. */
const STALE_MS = 30 * 60_000;

/** True when the scam guard stopped or is holding purchases on this call. */
function scamStopped(call: CallSummary) {
  return call.scamHold.active || call.outcome === "declined_scam";
}

/** Wall clock ticking every `ms` (client-only: the gate never renders on the server). */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

export function LiveCalls() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const live = useQuery(api.dashboard.liveCall, args);
  const recent = useQuery(api.dashboard.recentCalls, args);
  const now = useNow(30_000);
  const tz = household?.timezone;
  const name = household?.preferredName ?? "Caller";
  const lastActivity = live
    ? Math.max(live.call.startedAt, live.turns.at(-1)?.at ?? 0)
    : 0;
  const onCall = live?.live === true && now - lastActivity < STALE_MS;

  return (
    <>
      <PageHeader
        title="Live calls"
        subtitle="Updates the moment Errand Line hears or says something."
        aside={
          live ? (
            onCall ? (
              <Badge tone="good" className="text-lg">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent"
                />
                On a call now
              </Badge>
            ) : live.live ? (
              <Badge>Call not closed</Badge>
            ) : (
              <Badge>Last call ended</Badge>
            )
          ) : null
        }
      />
      {live === undefined ? (
        <Loading />
      ) : live === null ? (
        <Empty>
          No calls yet. When {name} calls, the conversation appears here.
        </Empty>
      ) : (
        <>
          <ScamBanner call={live.call} name={name} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Transcript live={live} name={name} timezone={tz} />
            <div className="min-w-0 space-y-6">
              <ScamPanel call={live.call} />
              <CallDetails call={live.call} timezone={tz} />
              <LatencySummary turns={live.turns} />
            </div>
          </div>
        </>
      )}
      <div className="mt-8">
        <RecentCalls recent={recent} timezone={tz} />
      </div>
    </>
  );
}

/** Impossible to miss on the big screen: a declined scam or an active hold. */
function ScamBanner({ call, name }: { call: CallSummary; name: string }) {
  if (!scamStopped(call)) return null;
  const declined = call.outcome === "declined_scam";
  return (
    <section
      role="alert"
      aria-label="Scam warning"
      className="mb-6 rounded-2xl border-4 border-danger bg-danger-soft px-6 py-5 text-danger"
    >
      <p className="text-2xl font-bold sm:text-3xl">
        {declined
          ? "Possible scam: Errand Line declined the purchase"
          : "Possible scam: purchases are on hold for this call"}
      </p>
      <p className="mt-2 text-lg break-words sm:text-xl">
        {call.scamHold.reason ??
          `Errand Line stopped a risky request during ${name}’s call.`}
      </p>
      <p className="mt-2 text-base sm:text-lg">
        No money moved. Scam alerts always go to the family; see Alerts.
      </p>
    </section>
  );
}

function Transcript({
  live,
  name,
  timezone,
}: {
  live: Live;
  name: string;
  timezone?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const callId = live.call._id;
  const lastTurn = live.turns.at(-1)?._id;

  // A new call starts pinned to the bottom again.
  useEffect(() => {
    pinned.current = true;
  }, [callId]);

  // Follow new turns unless the viewer scrolled up to read. Instant, not
  // smooth: a smooth scroll fires mid-animation scroll events that unpin it.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [callId, lastTurn]);

  if (!live.call.transcriptVisible) {
    return (
      <Card title="Transcript">
        <Empty>
          This is a chat-only call. {name} hasn&apos;t chosen to share chat
          transcripts, so only the summary is shown.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title="Transcript"
      className="min-w-0"
      action={
        <span className="text-base text-muted">
          {live.turns.length} {live.turns.length === 1 ? "turn" : "turns"}
        </span>
      }
    >
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        role="log"
        aria-label="Live transcript"
        tabIndex={0}
        className="max-h-[65vh] min-h-64 space-y-4 overflow-y-auto rounded-lg pr-1 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
      >
        {live.turns.length === 0 ? (
          <Empty>Waiting for the first words…</Empty>
        ) : (
          live.turns.map((turn) => (
            <TurnRow
              key={turn._id}
              turn={turn}
              name={name}
              timezone={timezone}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function TurnRow({
  turn,
  name,
  timezone,
}: {
  turn: Turn;
  name: string;
  timezone?: string;
}) {
  const isCaller = turn.speaker === "user";
  const scam = turn.scam ? scamLevel(turn.scam.score) : null;
  return (
    <article
      className={`rounded-2xl border border-line px-5 py-4 ${
        isCaller ? "mr-4 bg-caller sm:mr-16" : "ml-4 bg-agent sm:ml-16"
      }`}
    >
      <header className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-lg font-bold">
          {isCaller ? name : "Errand Line"}
        </span>
        <time
          className="text-base text-muted"
          dateTime={new Date(turn.at).toISOString()}
        >
          {formatTime(turn.at, timezone)}
        </time>
      </header>
      {turn.redacted || turn.text === null ? (
        <p className="text-xl italic text-muted sm:text-2xl">
          [This part is private]
        </p>
      ) : (
        <p className="text-xl leading-relaxed break-words sm:text-2xl">
          {turn.text}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!isCaller && <TurnLatency latency={turn.latency} />}
        {turn.tools.map((tool, i) => (
          <Badge key={`${tool.name}-${i}`} tone="info" wrap>
            {titleCase(tool.name)}
            {tool.result && ` · ${titleCase(tool.result)}`}
          </Badge>
        ))}
        {turn.refused && (
          <Badge tone="warn" wrap>
            Model declined · templated line spoken
          </Badge>
        )}
        {scam && scam !== "clear" && turn.scam && (
          <Badge tone={LEVEL[scam].tone} wrap>
            Scam check: {LEVEL[scam].label}
            {turn.scam.signals.length > 0 &&
              ` · ${turn.scam.signals.join(", ")}`}
          </Badge>
        )}
      </div>
    </article>
  );
}

function TurnLatency({ latency }: { latency: Turn["latency"] }) {
  // Voice-to-voice when the voice stack logs it; else heard-to-first-words.
  const headline = latency.voiceToVoiceMs ?? latency.replyMs;
  const stages = [
    { label: "Hearing", ms: latency.sttMs },
    { label: "Claude first token", ms: latency.llmMs },
    { label: "Voice", ms: latency.ttsMs },
  ].filter((stage) => stage.ms != null);
  if (headline == null && stages.length === 0) return null;
  return (
    <>
      {headline != null && (
        <Badge tone="info">
          {latency.voiceToVoiceMs != null ? "Response" : "Reply started"}{" "}
          {formatMs(headline)}
        </Badge>
      )}
      {stages.length > 0 && (
        <span className="text-base text-muted">
          {stages.map((s) => `${s.label} ${formatMs(s.ms)}`).join(" · ")}
        </span>
      )}
    </>
  );
}

function ScamPanel({ call }: { call: CallSummary }) {
  const level = scamLevel(call.scamScore);
  const stopped = scamStopped(call);
  const tone: Tone = stopped ? "danger" : LEVEL[level].tone;
  const score = Math.round(scamFraction(call.scamScore) * 100);
  return (
    <Card
      title="Scam check"
      action={
        stopped ? (
          <Badge tone="danger" className="text-lg">
            {call.outcome === "declined_scam"
              ? "Scam declined"
              : "Purchases on hold"}
          </Badge>
        ) : (
          <Badge tone={tone} className="text-lg">
            {LEVEL[level].label}
          </Badge>
        )
      }
    >
      <Meter value={score / 100} label="Scam risk score" tone={tone} />
      <p className="mt-2 text-lg tabular-nums">
        Risk score <span className="text-2xl font-bold">{score}</span>
        <span className="text-muted"> / 100</span>
      </p>
      {call.scamHold.active && call.scamHold.reason && (
        <p className="mt-3 rounded-lg bg-danger-soft px-4 py-3 text-lg break-words text-danger">
          {call.scamHold.reason}
        </p>
      )}
      {call.scamSignals.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Scam signals">
          {call.scamSignals.map((signal) => (
            <li key={signal} className="max-w-full">
              <Badge tone={tone === "good" ? "neutral" : tone} wrap>
                {signal}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {call.scamReasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-6 text-lg">
          {call.scamReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CallDetails({
  call,
  timezone,
}: {
  call: CallSummary;
  timezone?: string;
}) {
  const outcome = OUTCOME[call.outcome];
  const duration = formatDuration(call.startedAt, call.endedAt);
  return (
    <Card title="This call">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-lg">
        <dt className="text-muted">Started</dt>
        <dd>{formatDateTime(call.startedAt, timezone)}</dd>
        <dt className="text-muted">Length</dt>
        <dd>{duration ?? "In progress"}</dd>
        <dt className="text-muted">Type</dt>
        <dd>{KIND[call.kind]}</dd>
        <dt className="text-muted">Outcome</dt>
        <dd>
          <Badge tone={outcome.tone}>{outcome.label}</Badge>
        </dd>
      </dl>
      {call.summary && <p className="mt-4 text-lg">{call.summary}</p>}
      <MoodNote call={call} />
      <Overrides call={call} timezone={timezone} />
    </Card>
  );
}

/** Nearest-rank percentile (same as the harness report). */
function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    )
  ];
}

function measured(values: (number | null)[]) {
  return values.filter((ms): ms is number => ms != null);
}

function LatencySummary({ turns }: { turns: Turn[] }) {
  const replies = turns.filter((t) => t.speaker === "assistant");
  const v2v = measured(replies.map((t) => t.latency.voiceToVoiceMs));
  // Until the voice stack logs speech-end and first-audio times, report the
  // agent-side span (final transcript to first reply text) instead.
  const headline =
    v2v.length > 0
      ? { name: "Voice-to-voice", values: v2v }
      : {
          name: "Heard to first words",
          values: measured(replies.map((t) => t.latency.replyMs)),
        };
  const ttft = measured(replies.map((t) => t.latency.llmMs));
  if (headline.values.length === 0 && ttft.length === 0) return null;
  const stats = [
    { label: `${headline.name} p50`, value: percentile(headline.values, 50) },
    { label: `${headline.name} p95`, value: percentile(headline.values, 95) },
    { label: "Claude first token p50", value: percentile(ttft, 50) },
  ];
  const n = headline.values.length;
  return (
    <Card title="Response time">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-base text-muted">{s.label}</dt>
            <dd className="text-3xl font-bold tabular-nums">
              {formatMs(s.value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-base text-muted">
        This call · {n} {n === 1 ? "reply" : "replies"} measured
      </p>
    </Card>
  );
}

function RecentCalls({
  recent,
  timezone,
}: {
  recent: CallSummary[] | undefined;
  timezone?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  if (recent === undefined) return <Loading />;
  const shown = showAll ? recent : recent.slice(0, 8);
  return (
    <Card title="Recent calls">
      {recent.length === 0 ? (
        <Empty>No calls yet.</Empty>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {shown.map((call) => {
              const outcome = OUTCOME[call.outcome];
              const level = scamLevel(call.scamScore);
              return (
                <li
                  key={call._id}
                  className="flex flex-wrap items-start justify-between gap-3 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold">
                      {formatDateTime(call.startedAt, timezone)}
                      <span className="ml-2 font-normal text-muted">
                        {KIND[call.kind]}
                        {call.endedAt === null && " · in progress"}
                      </span>
                    </p>
                    <p className="mt-1 text-lg break-words">
                      {call.summary ?? (
                        <span className="text-muted">No summary yet.</span>
                      )}
                    </p>
                    {!call.transcriptVisible && (
                      <p className="mt-1 text-base text-muted">
                        Transcript not shared
                      </p>
                    )}
                    <MoodNote call={call} />
                    <Overrides call={call} timezone={timezone} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {call.scamHold.active &&
                    call.outcome !== "declined_scam" ? (
                      <Badge tone="danger">Scam hold</Badge>
                    ) : (
                      !scamStopped(call) &&
                      level !== "clear" && (
                        <Badge tone={LEVEL[level].tone}>
                          Scam: {LEVEL[level].label}
                        </Badge>
                      )
                    )}
                    <Badge tone={outcome.tone}>{outcome.label}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
          {recent.length > 8 && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 rounded-lg px-3 py-2 text-lg font-semibold text-accent hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
            >
              {showAll ? "Show fewer" : `Show all ${recent.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

/** WB-3 / §14.2: shown only when the caller agreed to share mood notes (enforced server-side). */
function MoodNote({ call }: { call: CallSummary }) {
  if (!call.moodNote) return null;
  return (
    <p className="mt-2 rounded-lg bg-info-soft px-3 py-2 text-base text-info">
      <span className="font-semibold">Mood note: </span>
      {call.moodNote}
    </p>
  );
}

/** SCM-6: who lifted a scam hold on this call, and when. */
function Overrides({
  call,
  timezone,
}: {
  call: CallSummary;
  timezone?: string;
}) {
  if (call.scamOverrides.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-base" aria-label="Scam hold overrides">
      {call.scamOverrides.map((o, i) => (
        <li key={i} className="text-warn">
          Scam hold lifted by <span className="font-semibold">{o.by}</span> ·{" "}
          {formatDateTime(o.at, timezone)}
          {o.note && ` · “${o.note}”`}
        </li>
      ))}
    </ul>
  );
}
