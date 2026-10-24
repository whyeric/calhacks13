"use client";

import { useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/format";
import { useAccessArgs } from "./access";
import { ChooseMemberNotice, useFamilyAction } from "./family";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  PageHeader,
} from "./ui";

/** Cut-list item 4 (§7): set NEXT_PUBLIC_MEMORY_READONLY=1 to hide delete. */
const READ_ONLY = process.env.NEXT_PUBLIC_MEMORY_READONLY === "1";

export function Memory() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const memory = useQuery(api.dashboard.memory, args);
  const name = household?.preferredName ?? "the caller";
  return (
    <>
      <PageHeader
        title="Memory"
        subtitle={`What Errand Line remembers about ${name}, in their own words.`}
        aside={
          memory ? (
            <Badge tone="info" className="text-lg">
              {memory.facts.length} remembered
            </Badge>
          ) : undefined
        }
      />
      {memory === undefined ? (
        <Loading />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title="Remembered facts">
            {memory.facts.length === 0 ? (
              <Empty>Nothing remembered yet.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {memory.facts.map((fact) => (
                  <li key={fact._id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 text-xl font-semibold break-words">
                        {fact.text}
                      </p>
                      <Badge>{fact.category}</Badge>
                    </div>
                    <blockquote className="mt-2 border-l-4 border-accent/50 pl-4 text-lg italic text-muted">
                      &ldquo;{fact.evidence}&rdquo;
                    </blockquote>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-base text-muted">
                        {fact.sourceCallStartedAt != null ? (
                          <>
                            From the call on{" "}
                            {formatDateTime(
                              fact.sourceCallStartedAt,
                              household?.timezone,
                            )}
                          </>
                        ) : (
                          <>
                            Remembered{" "}
                            {formatDateTime(
                              fact.createdAt,
                              household?.timezone,
                            )}
                          </>
                        )}
                      </p>
                      {!READ_ONLY && (
                        <ForgetButton factId={fact._id} name={name} />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="min-w-0 space-y-6">
            <Card title="Follow-ups to ask">
              {memory.followups.length === 0 ? (
                <Empty>No open follow-ups.</Empty>
              ) : (
                <ul className="space-y-3">
                  {memory.followups.map((f) => (
                    <li
                      key={f._id}
                      className="rounded-xl bg-accent-soft px-4 py-3 text-lg"
                    >
                      {f.speakable}
                      {f.notBefore > Date.now() && (
                        <span className="mt-1 block text-base text-muted">
                          From{" "}
                          {formatDateTime(f.notBefore, household?.timezone)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {memory.pastFollowups.length > 0 && (
              <Card title="Already asked">
                <ul className="space-y-3">
                  {memory.pastFollowups.map((f) => (
                    <li
                      key={f._id}
                      className="flex items-start justify-between gap-3 text-lg text-muted"
                    >
                      <span className="min-w-0 break-words line-through decoration-1">
                        {f.speakable}
                      </span>
                      <Badge tone={f.status === "closed" ? "good" : "neutral"}>
                        {f.status === "closed" ? "Closed" : "Asked"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ForgetButton({
  factId,
  name,
}: {
  factId: Id<"memory_facts">;
  name: string;
}) {
  const forget = useFamilyAction(api.dashboard.forgetFact);
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Forget this
      </Button>
    );
  return (
    <div className="basis-full rounded-xl border border-danger/40 bg-danger-soft p-4">
      {!forget.ready ? (
        <ChooseMemberNotice />
      ) : (
        <>
          <p className="text-lg text-danger">
            Errand Line will stop using this with {name}, and the words it came
            from are removed from the transcript. This can&apos;t be undone.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              variant="danger"
              disabled={forget.pending}
              onClick={() => forget.call({ factId })}
            >
              {forget.pending ? "Forgetting…" : "Yes, forget it"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </>
      )}
      <ErrorText>{forget.error}</ErrorText>
    </div>
  );
}
