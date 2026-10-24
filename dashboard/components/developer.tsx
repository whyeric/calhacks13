"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatDateTime, formatMs } from "@/lib/format";
import { useAccessArgs } from "./access";
import {
  Badge,
  Card,
  Empty,
  Loading,
  Meter,
  PageHeader,
  Stat,
  type Tone,
} from "./ui";

const ms = (v: number | null) => formatMs(v === null ? null : Math.round(v));
const usd = (v: number | null) =>
  v === null ? "—" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
const pct = (v: number | null) =>
  v === null ? "—" : `${Math.round(v * 100)}%`;

function toneFor(
  value: number | null,
  target: number,
  lowerIsBetter = true,
): Tone {
  if (value === null) return "neutral";
  const ok = lowerIsBetter ? value <= target : value >= target;
  return ok ? "good" : "danger";
}

/** Per-stage targets (§12.1 voice-to-voice, §12.2 stage budget p50). */
const STAGE_TARGET: Record<string, { p50?: number; p95?: number }> = {
  voiceToVoice: { p50: 800, p95: 1500 },
  stt: { p50: 100 },
  llm: { p50: 300 },
  tts: { p50: 100 },
};

export function Developer() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const stats = useQuery(api.dashboard.developer, args);
  const tz = household?.timezone;
  if (stats === undefined)
    return (
      <>
        <PageHeader title="Developer panel" />
        <Loading />
      </>
    );
  const t = stats.targets;
  const v2v = stats.stages.find((s) => s.key === "voiceToVoice")!;
  const llm = stats.stages.find((s) => s.key === "llm")!;
  return (
    <>
      <PageHeader
        title="Developer panel"
        subtitle={`Live from the last ${stats.callsAnalyzed} calls · ${stats.modelTurns} Claude turns`}
        aside={<Badge tone="info">Claude Haiku 5.5</Badge>}
      />
      {stats.modelTurns === 0 ? (
        <Empty>
          No Claude turns logged yet. Numbers appear after the first call.
        </Empty>
      ) : (
        <div className="space-y-6">
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Voice to voice p50"
              value={ms(v2v.p50 ?? null)}
              hint={`target ≤ ${t.voiceToVoiceP50Ms} ms · p95 ${ms(v2v.p95 ?? null)} (≤ ${t.voiceToVoiceP95Ms} ms)`}
              tone={toneFor(v2v.p50, t.voiceToVoiceP50Ms)}
            />
            <Stat
              label="Claude first token p50"
              value={ms(llm.p50 ?? null)}
              hint={`target ≤ ${t.llmP50Ms} ms · p95 ${ms(llm.p95 ?? null)}`}
              tone={toneFor(llm.p50, t.llmP50Ms)}
            />
            <Stat
              label="Prompt cache hit, turn 1"
              value={pct(stats.cache.rate)}
              hint={`${stats.cache.hits} of ${stats.cache.known} calls · target ≥ ${Math.round(t.firstTurnCacheHit * 100)}%`}
              tone={toneFor(stats.cache.rate, t.firstTurnCacheHit, false)}
            />
            <Stat
              label="Claude cost per call (p50)"
              value={usd(stats.cost.p50)}
              hint={`max ${usd(stats.cost.max)} · target ≤ $${t.costPerCallUsd.toFixed(2)}`}
              tone={toneFor(stats.cost.max, t.costPerCallUsd)}
            />
          </dl>
          {v2v.n === 0 && (
            <p className="rounded-lg bg-warn-soft px-4 py-3 text-lg text-warn">
              Voice-to-voice needs the speech-end and first-audio marks from the
              voice stack; until they are logged, use “Final transcript → first
              reply text”.
            </p>
          )}

          <Card title="Latency by stage">
            <div className="overflow-x-auto">
              <table className="w-full text-lg">
                <caption className="sr-only">
                  p50 and p95 latency per stage
                </caption>
                <thead>
                  <tr className="border-b border-line text-left text-base text-muted">
                    <th scope="col" className="py-2 font-semibold">
                      Stage
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      p50
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      p95
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Target
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Turns
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.stages.map((s) => {
                    const target = STAGE_TARGET[s.key];
                    return (
                      <tr key={s.key} className="border-b border-line/60">
                        <th
                          scope="row"
                          className="py-3 pr-3 text-left font-normal"
                        >
                          {s.label}
                        </th>
                        <td
                          className={`py-3 pl-3 text-right tabular-nums font-bold ${
                            target?.p50 !== undefined && s.p50 !== null
                              ? s.p50 <= target.p50
                                ? "text-accent"
                                : "text-danger"
                              : ""
                          }`}
                        >
                          {ms(s.p50)}
                        </td>
                        <td
                          className={`py-3 pl-3 text-right tabular-nums ${
                            target?.p95 !== undefined && s.p95 !== null
                              ? s.p95 <= target.p95
                                ? "text-accent"
                                : "text-danger"
                              : ""
                          }`}
                        >
                          {ms(s.p95)}
                        </td>
                        <td className="py-3 pl-3 text-right text-base text-muted tabular-nums">
                          {target
                            ? [
                                target.p50 !== undefined &&
                                  `p50 ≤ ${target.p50}`,
                                target.p95 !== undefined &&
                                  `p95 ≤ ${target.p95}`,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : "—"}
                        </td>
                        <td className="py-3 pl-3 text-right tabular-nums text-muted">
                          {s.n}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Calls">
            <div className="overflow-x-auto">
              <table className="w-full text-lg">
                <caption className="sr-only">Per-call cost and cache</caption>
                <thead>
                  <tr className="border-b border-line text-left text-base text-muted">
                    <th scope="col" className="py-2 font-semibold">
                      Started
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Claude turns
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Turn 1 cache
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Voice p50
                    </th>
                    <th
                      scope="col"
                      className="py-2 pl-3 text-right font-semibold"
                    >
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.perCall
                    .filter((c) => c.modelTurns > 0)
                    .map((c) => (
                      <tr key={c.callId} className="border-b border-line/60">
                        <td className="py-2 pr-3">
                          {formatDateTime(c.startedAt, tz)}
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums">
                          {c.modelTurns}
                        </td>
                        <td className="py-2 pl-3 text-right">
                          {c.firstTurnCacheHit === null ? (
                            "—"
                          ) : c.firstTurnCacheHit ? (
                            <Badge tone="good">Hit</Badge>
                          ) : (
                            <Badge tone="danger">Miss</Badge>
                          )}
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums">
                          {ms(c.voiceToVoiceP50Ms)}
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums">
                          <span
                            className={
                              c.costUsd !== null && c.costUsd > t.costPerCallUsd
                                ? "text-danger font-bold"
                                : ""
                            }
                          >
                            {usd(c.costUsd)}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {stats.cost.max !== null && (
              <div className="mt-4">
                <Meter
                  value={stats.cost.max / t.costPerCallUsd}
                  label="Most expensive call against the $0.05 budget"
                  tone={toneFor(stats.cost.max, t.costPerCallUsd)}
                />
                <p className="mt-2 text-base text-muted">
                  Most expensive call against the ${t.costPerCallUsd.toFixed(2)}{" "}
                  budget. Cache writes are priced as 5-minute writes
                  {stats.turnsOver100kPrompt > 0 &&
                    ` · ${stats.turnsOver100kPrompt} turns over 100K tokens (higher tier)`}
                  .
                </p>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
