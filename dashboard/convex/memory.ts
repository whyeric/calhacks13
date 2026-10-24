import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { requireFamily } from "./auth";
import {
  REDACTED_BY_CALLER,
  REDACTED_BY_FAMILY,
  SCAM_TURN_THRESHOLD,
  WRITER_SCHEMA,
  evidenceScore,
  factsToForget,
  forgetScore,
  isForgetRequest,
  localDate,
  validateWrite,
  type WriterFact,
  type WriterFollowup,
  type WriterOutput,
  type WriterTurn,
} from "./memoryRules";

export const list = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, { householdId }) => {
    await requireFamily(ctx, householdId);
    return {
      facts: await ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", householdId).eq("status", "active"),
        )
        .take(200),
      followups: await ctx.db
        .query("followups")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", householdId).eq("status", "open"),
        )
        .take(20),
    };
  },
});

/** #57: the opener was spoken on this call; it won't be offered again. Idempotent. */
export const followupAsked = internalMutation({
  args: { callId: v.id("calls"), followupId: v.id("followups") },
  handler: async (ctx, { callId, followupId }) => {
    const [call, followup] = await Promise.all([
      ctx.db.get(callId),
      ctx.db.get(followupId),
    ]);
    if (!call) throw new ConvexError("Call not found");
    if (
      !followup ||
      !call.householdId ||
      followup.householdId !== call.householdId
    )
      throw new ConvexError("Follow-up not found for this call");
    if (followup.status === "open")
      await ctx.db.patch(followupId, {
        status: "asked",
        askedInCallId: callId,
      });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------------------
// #32 #37 #42 #76 #69: post-call memory writer (§11.5). Scheduled by calls.end.
// ---------------------------------------------------------------------------------------

const MODEL = () => process.env.CLAUDE_MODEL_MEMORY || "claude-haiku-5-5";
const MAX_TURNS = 400;

type CallWithScam = Doc<"calls"> & { scamIncident?: string };

function quarantined(call: CallWithScam): boolean {
  return (
    call.scamHold.active ||
    call.outcome === "declined_scam" ||
    call.scamScore >= SCAM_TURN_THRESHOLD ||
    !!call.scamIncident
  );
}

/** Everything the writer needs, read from the database (used by the model prompt and by the
 * mutation that re-validates the model's output inside one transaction). */
async function loadWriterInput(ctx: QueryCtx, callId: Id<"calls">) {
  const call = (await ctx.db.get(callId)) as CallWithScam | null;
  if (!call?.householdId || call.endedAt === undefined) return null;
  const household = await ctx.db.get(call.householdId);
  if (!household) return null;
  const holdAt = call.scamHold.at;
  const turns: WriterTurn[] = (
    await ctx.db
      .query("turns")
      .withIndex("by_call_idx", (q) => q.eq("callId", callId))
      .take(MAX_TURNS)
  ).map((t) => ({
    idx: t.idx,
    speaker: t.speaker,
    text: t.redacted ? "" : t.text,
    redacted: t.redacted,
    // #27 contract: a turn is flagged by its classifier score, any scam signal, or by being
    // at or after the scam hold. Flagged turns never back a fact.
    scamScore:
      (t.scam?.signals.length ?? 0) > 0 ||
      (holdAt !== undefined && t.at >= holdAt)
        ? 1
        : (t.scam?.score ?? 0),
  }));
  const facts: (WriterFact & { doc: Doc<"memory_facts"> })[] = (
    await ctx.db
      .query("memory_facts")
      .withIndex("by_household_status", (q) =>
        q.eq("householdId", household._id).eq("status", "active"),
      )
      .take(200)
  ).map((f) => ({
    id: f._id,
    text: f.text,
    category: f.category,
    evidence: f.evidence,
    doc: f,
  }));
  const open = await ctx.db
    .query("followups")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", household._id).eq("status", "open"),
    )
    .take(30);
  const asked = (
    await ctx.db
      .query("followups")
      .withIndex("by_household_status", (q) =>
        q.eq("householdId", household._id).eq("status", "asked"),
      )
      .order("desc")
      .take(30)
  ).filter((f) => f.askedInCallId === callId);
  const followups: WriterFollowup[] = [...open, ...asked].map((f) => ({
    id: f._id,
    speakable: f.speakable,
    notBefore: f.notBefore,
    status: f.status,
  }));
  const forgotten = await ctx.db
    .query("memory_facts")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", household._id).eq("status", "forgotten"),
    )
    .order("desc")
    .take(100);
  return { call, household, turns, facts, followups, forgotten };
}

export const writerInput = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const input = await loadWriterInput(ctx, callId);
    if (!input) return null;
    const { call, household, turns, facts, followups } = input;
    return {
      done: call.memoryWrite?.status === "written",
      callerTurns: turns.filter((t) => t.speaker === "user" && !t.redacted)
        .length,
      prompt: JSON.stringify({
        today: localDate(Date.now(), household.timezone),
        caller: household.preferredName,
        family: household.familyContacts.map((c) => `${c.name} (${c.relation})`),
        sharing: household.sharing,
        firstCall: household.introducedAt === undefined,
        scamFlaggedCall: quarantined(call),
        currentFacts: facts.map(({ id, text, category, evidence }) => ({
          id,
          text,
          category,
          evidence,
        })),
        openFollowups: followups.map((f) => ({
          id: f.id,
          speakable: f.speakable,
          status: f.status,
          notBefore: localDate(f.notBefore, household.timezone),
        })),
        transcript: turns
          .filter((t) => !t.redacted && t.text.trim())
          .map((t) => ({
            speaker: t.speaker === "user" ? "caller" : "agent",
            text: t.text.slice(0, 2000),
            ...((t.scamScore ?? 0) >= SCAM_TURN_THRESHOLD
              ? { scamFlagged: true }
              : {}),
          })),
      }),
    };
  },
});

const WRITER_SYSTEM = `You write the memory for Errand Line, a phone assistant for an older adult, after a call ends. You receive the call transcript, the facts already remembered and the open follow-ups. Return JSON only, matching the schema.

summary: 2 to 4 plain sentences about this call: what the caller wanted, what happened (orders, alerts), and anything personal they shared. Never include payment details. If the call was scam-flagged, describe it as an incident ("a caller claiming to be X asked for Y; Errand Line declined"), never as a fact about the caller.

facts_add: new durable facts about the caller's life: people and relationships, routines and preferences, events and plans, interests. Each needs "evidence": the caller's exact words copied from ONE caller turn (not the agent's words). Only what the caller said themselves. Never record payment details, anything the caller asked to forget, claims made by other people during a scam-flagged part of the call, or health conditions the caller did not state themselves (never infer them). A health or mood fact the caller stated uses category health_mention. Do not repeat a fact that is already remembered. At most 10.

facts_supersede: when the caller corrected or updated a remembered fact ("the recital moved to next week"), give that fact's id, the new text and the caller's exact words. Newest wins.

followups_add: at most 3 short, warm questions to ask on a later call about something the caller mentioned (an upcoming event, a plan), written as you would say them aloud, e.g. "How did Lily's recital go on Saturday?". notBefore is the date (YYYY-MM-DD) from which asking makes sense, e.g. the day after the event. Only add one if it would be natural to ask.

followups_close: ids of open follow-ups the caller answered or that no longer make sense.
followups_reschedule: when a plan moved, the follow-up id and its new notBefore date.

mood_note: one short factual sentence when the caller themselves talked about their mood or health (e.g. "Said she has been feeling lonely since her sister moved."), with mood_evidence their exact words. Otherwise null for both.

settings: only when the caller clearly said so in this call, otherwise null for each field: preferredName (what they asked to be called), chatTranscripts (true if they agreed their family may read full chat transcripts, false if they declined), moodNotes (true or false, same idea for mood notes). evidence: the caller's exact words for the change, or null.

Everything you return is checked against the transcript in code; quotes that are not the caller's words are dropped.`;

function client(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey
    ? new Anthropic({ apiKey, maxRetries: 1, timeout: 50_000 })
    : null;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export const write = internalAction({
  args: { callId: v.id("calls"), attempt: v.optional(v.number()) },
  handler: async (ctx, { callId, attempt = 0 }): Promise<null> => {
    const started = Date.now();
    const input = await ctx.runQuery(internal.memory.writerInput, { callId });
    if (!input || input.done) return null;
    const record = (
      status: "skipped" | "refused" | "failed",
      notes: string[],
    ) =>
      ctx.runMutation(internal.memory.recordWrite, {
        callId,
        memoryWrite: {
          status,
          at: Date.now(),
          ms: Date.now() - started,
          added: 0,
          dropped: 0,
          notes,
        },
      });
    if (input.callerTurns === 0) {
      await record("skipped", ["no caller turns"]);
      return null;
    }
    const anthropic = client();
    if (!anthropic) {
      await record("skipped", ["ANTHROPIC_API_KEY is not set"]);
      return null;
    }
    let message: Anthropic.Message;
    try {
      message = await anthropic.messages.create({
        model: MODEL(),
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: WRITER_SCHEMA },
        },
        system: WRITER_SYSTEM,
        messages: [{ role: "user", content: input.prompt }],
      });
    } catch (error) {
      const retryable =
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError ||
        error instanceof Anthropic.APIConnectionError;
      if (retryable && attempt < 2) {
        await ctx.scheduler.runAfter(5_000 * (attempt + 1), internal.memory.write, {
          callId,
          attempt: attempt + 1,
        });
        return null;
      }
      const status =
        error instanceof Anthropic.APIError ? ` ${error.status}` : "";
      await record("failed", [`model request failed${status}`]);
      return null;
    }
    const usage = {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    };
    // Usage and timing only: never transcript text in logs.
    console.log(
      JSON.stringify({
        event: "memory_write",
        callId,
        stopReason: message.stop_reason,
        ms: Date.now() - started,
        ...usage,
      }),
    );
    if (message.stop_reason === "refusal") {
      await record("refused", ["model refused; nothing written"]);
      return null;
    }
    let output: Partial<WriterOutput>;
    try {
      if (message.stop_reason === "max_tokens") throw new Error("truncated");
      output = JSON.parse(textOf(message));
    } catch {
      await record("failed", ["model output was not valid JSON"]);
      return null;
    }
    await ctx.runMutation(internal.memory.applyWrite, {
      callId,
      output,
      startedAt: started,
    });
    return null;
  },
});

export const recordWrite = internalMutation({
  args: {
    callId: v.id("calls"),
    memoryWrite: v.object({
      status: v.union(
        v.literal("skipped"),
        v.literal("refused"),
        v.literal("failed"),
      ),
      at: v.number(),
      ms: v.number(),
      added: v.number(),
      dropped: v.number(),
      notes: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, { callId, memoryWrite }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.memoryWrite?.status === "written") return;
    await ctx.db.patch(callId, { memoryWrite });
    // A first call still counts as introduced even when no memory was written.
    if (call.householdId) await markIntroduced(ctx, call);
  },
});

async function markIntroduced(ctx: MutationCtx, call: Doc<"calls">) {
  const household = call.householdId && (await ctx.db.get(call.householdId));
  if (household && household.introducedAt === undefined)
    await ctx.db.patch(household._id, { introducedAt: call.startedAt });
}

/**
 * Validate the model's output in code against the current database state, then write it.
 * One transaction: facts, supersessions, follow-ups, summary, mood note and settings.
 */
export const applyWrite = internalMutation({
  // The model's JSON is untrusted and fully re-checked by validateWrite.
  args: { callId: v.id("calls"), output: v.any(), startedAt: v.number() },
  handler: async (ctx, { callId, output, startedAt }) => {
    const input = await loadWriterInput(ctx, callId);
    if (!input) throw new ConvexError("Call not found or not ended");
    const { call, household, turns, facts, followups, forgotten } = input;
    if (call.memoryWrite?.status === "written") return { alreadyWritten: true };
    const now = Date.now();
    const result = validateWrite(
      output && typeof output === "object" ? output : {},
      {
        turns,
        facts,
        followups,
        quarantined: quarantined(call),
        timezone: household.timezone,
        now,
        moodNotesShared: household.sharing.moodNotes,
      },
    );
    // Forget means forget (§11.6): never re-learn something the household forgot.
    const isForgotten = (text: string) =>
      forgotten.some(
        (f) =>
          forgetScore(f.text, text) >= 0.8 || evidenceScore(f.evidence, text) >= 0.8,
      );
    for (const list of [result.factsAdd, result.factsSupersede] as const)
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        const text = "text" in item ? item.text : item.newText;
        if (isForgotten(text) || isForgotten(item.evidence)) {
          result.dropped.push(`fact "${text.slice(0, 60)}": was forgotten`);
          list.splice(i, 1);
        }
      }
    const base = {
      householdId: household._id,
      sourceCallId: callId,
      createdAt: now,
      status: "active" as const,
    };
    for (const f of result.factsSupersede) {
      const old = facts.find((x) => x.id === f.factId)!.doc;
      const newId = await ctx.db.insert("memory_facts", {
        ...base,
        text: f.newText,
        category: old.category,
        evidence: f.evidence,
      });
      await ctx.db.patch(old._id, { status: "superseded", supersededBy: newId });
    }
    for (const f of result.factsAdd)
      await ctx.db.insert("memory_facts", {
        ...base,
        text: f.text,
        category: f.category,
        evidence: f.evidence,
      });
    for (const f of result.followupsAdd)
      await ctx.db.insert("followups", {
        householdId: household._id,
        speakable: f.speakable,
        sourceCallId: callId,
        notBefore: f.notBefore,
        status: "open",
      });
    for (const id of result.followupsClose)
      await ctx.db.patch(id as Id<"followups">, { status: "closed" });
    for (const r of result.followupsReschedule)
      // A moved plan is asked about again once its new date comes.
      await ctx.db.patch(r.followupId as Id<"followups">, {
        notBefore: r.notBefore,
        status: "open",
      });
    if (Object.keys(result.settings).length) {
      const { preferredName, ...sharing } = result.settings;
      await ctx.db.patch(household._id, {
        ...(preferredName ? { preferredName } : {}),
        sharing: { ...household.sharing, ...sharing },
      });
    }
    const incident = call.scamIncident?.trim();
    const summary = [incident, result.summary].filter(Boolean).join(" ");
    const added = result.factsAdd.length + result.factsSupersede.length;
    await ctx.db.patch(callId, {
      ...(summary ? { summary } : {}),
      ...(result.moodNote ? { moodNote: result.moodNote } : {}),
      memoryWrite: {
        status: "written",
        at: now,
        ms: now - startedAt,
        added,
        dropped: result.dropped.length,
        notes: result.dropped.slice(0, 20),
      },
    });
    await markIntroduced(ctx, call);
    if (result.dropped.length)
      console.log(
        JSON.stringify({
          event: "memory_dropped",
          callId,
          count: result.dropped.length,
          reasons: result.dropped.slice(0, 20),
        }),
      );
    return {
      alreadyWritten: false,
      added,
      followupsAdded: result.followupsAdd.length,
      followupsClosed: result.followupsClose.length,
      followupsRescheduled: result.followupsReschedule.length,
      dropped: result.dropped,
    };
  },
});

// ---------------------------------------------------------------------------------------
// #47: forget flow (MEM-5, MEM-6, §11.6). Forgetting marks the fact forgotten, redacts its
// evidence turn in the stored transcript and regenerates the source call's summary. The
// live conversation is never edited (§11.3).
// ---------------------------------------------------------------------------------------

/**
 * Forget one fact. No authorization here: callers check it (the agent route is
 * secret-authenticated; the dashboard calls requireFamily first). Idempotent.
 */
export async function forgetFact(
  ctx: MutationCtx,
  factId: Id<"memory_facts">,
  by: string,
): Promise<{ forgotten: boolean; redactedTurns: number }> {
  const fact = await ctx.db.get(factId);
  if (!fact || fact.status === "forgotten")
    return { forgotten: false, redactedTurns: 0 };
  await ctx.db.patch(factId, {
    status: "forgotten",
    forgottenAt: Date.now(),
    forgottenBy: by,
  });
  const marker = by === "caller" ? REDACTED_BY_CALLER : REDACTED_BY_FAMILY;
  let redacted = 0;
  for (const turn of await ctx.db
    .query("turns")
    .withIndex("by_call_idx", (q) => q.eq("callId", fact.sourceCallId))
    .take(MAX_TURNS))
    if (
      turn.speaker === "user" &&
      !turn.redacted &&
      evidenceScore(fact.evidence, turn.text) >= 0.8
    ) {
      await ctx.db.patch(turn._id, { text: marker, redacted: true });
      redacted++;
    }
  // Follow-ups about the forgotten thing go too.
  for (const status of ["open", "asked"] as const)
    for (const f of await ctx.db
      .query("followups")
      .withIndex("by_household_status", (q) =>
        q.eq("householdId", fact.householdId).eq("status", status),
      )
      .take(50))
      if (forgetScore(fact.text, f.speakable) >= 0.5)
        await ctx.db.patch(f._id, { status: "closed" });
  const source = await ctx.db.get(fact.sourceCallId);
  if (source?.endedAt !== undefined)
    await ctx.scheduler.runAfter(0, internal.memory.regenerateSummary, {
      callId: fact.sourceCallId,
    });
  return { forgotten: true, redactedTurns: redacted };
}

export const forgetFactInternal = internalMutation({
  args: { factId: v.id("memory_facts"), by: v.string() },
  handler: (ctx, { factId, by }) => forgetFact(ctx, factId, by.slice(0, 100)),
});

/**
 * forget_fact tool (MEM-5): the caller describes what to forget. Matching remembered facts
 * are forgotten, and matching caller turns of THIS call are redacted so the post-call writer
 * never learns them. Returns the forgotten facts' texts for the spoken confirmation.
 */
export const forgetForCall = internalMutation({
  args: { callId: v.id("calls"), description: v.string() },
  handler: async (ctx, { callId, description }) => {
    const text = description.trim().slice(0, 300);
    if (!text) throw new ConvexError("Describe what to forget");
    const call = await ctx.db.get(callId);
    if (!call?.householdId) throw new ConvexError("Call not found");
    const facts = await ctx.db
      .query("memory_facts")
      .withIndex("by_household_status", (q) =>
        q.eq("householdId", call.householdId!).eq("status", "active"),
      )
      .take(200);
    const matches = factsToForget(text, facts).slice(0, 5);
    for (const fact of matches) await forgetFact(ctx, fact._id, "caller");
    let redactedTurns = 0;
    for (const turn of await ctx.db
      .query("turns")
      .withIndex("by_call_idx", (q) => q.eq("callId", callId))
      .take(MAX_TURNS))
      if (
        turn.speaker === "user" &&
        !turn.redacted &&
        !isForgetRequest(turn.text) &&
        forgetScore(text, turn.text) >= 0.5
      ) {
        await ctx.db.patch(turn._id, {
          text: REDACTED_BY_CALLER,
          redacted: true,
        });
        redactedTurns++;
      }
    return {
      status:
        matches.length || redactedTurns ? ("forgotten" as const) : ("none" as const),
      forgotten: matches.map((f) => f.text),
      redactedTurns,
    };
  },
});

export const summaryInput = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call?.householdId) return null;
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_call_idx", (q) => q.eq("callId", callId))
      .take(MAX_TURNS);
    const forgotten = (
      await ctx.db
        .query("memory_facts")
        .withIndex("by_household_status", (q) =>
          q.eq("householdId", call.householdId!).eq("status", "forgotten"),
        )
        .take(100)
    ).filter((f) => f.sourceCallId === callId);
    return {
      transcript: turns
        .filter((t) => !t.redacted && t.text.trim())
        .map((t) => `${t.speaker === "user" ? "Caller" : "Agent"}: ${t.text}`)
        .join("\n")
        .slice(0, 60_000),
      forgotten: forgotten.map((f) => f.text),
    };
  },
});

export const REGENERATE_FALLBACK =
  "Summary removed: part of this call was forgotten at the caller's request.";

export const setSummary = internalMutation({
  args: { callId: v.id("calls"), summary: v.string() },
  handler: async (ctx, { callId, summary }) => {
    if (await ctx.db.get(callId))
      await ctx.db.patch(callId, { summary: summary.slice(0, 800) });
  },
});

/** Rewrite a call's summary without the forgotten parts (§11.6). Without a model, the old
 * summary is replaced by a neutral line, so a forgotten detail never survives in it. */
export const regenerateSummary = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<null> => {
    const input = await ctx.runQuery(internal.memory.summaryInput, { callId });
    if (!input) return null;
    let summary = REGENERATE_FALLBACK;
    const anthropic = client();
    if (anthropic && input.transcript)
      try {
        const message = await anthropic.messages.create({
          model: MODEL(),
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "medium",
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["summary"],
                properties: { summary: { type: "string" } },
              },
            },
          },
          system:
            "Summarize this phone call between an older adult and Errand Line, an AI phone assistant, in 2 to 4 plain sentences. Leave out completely anything listed under 'Forgotten', and anything shown as forgotten in the transcript. Never include payment details.",
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                forgotten: input.forgotten,
                transcript: input.transcript,
              }),
            },
          ],
        });
        if (message.stop_reason === "end_turn") {
          const parsed = JSON.parse(textOf(message));
          if (typeof parsed.summary === "string" && parsed.summary.trim())
            summary = parsed.summary.trim();
        }
      } catch {
        /* keep the neutral fallback */
      }
    await ctx.runMutation(internal.memory.setSummary, { callId, summary });
    return null;
  },
});
