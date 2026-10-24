/**
 * Pure rules for the memory writer (#32 #37 #42 #76 #69) and the forget flow (#47).
 * No Convex context here, so every rule is unit-testable and deterministic.
 *
 * Evidence match (MEM-7, §11.5): a fact is kept only when its evidence matches ONE caller turn
 * of this call that is not redacted and not scam-flagged. The match is word-level: both sides
 * are lower-cased and stripped of punctuation, and the longest run of evidence words found
 * in order inside the turn (a longest common subsequence over words) must cover at least
 * EVIDENCE_MATCH_THRESHOLD (80%) of the evidence words, with at least two evidence words
 * (or the whole turn). 80% tolerates speech-to-text slips and small paraphrases ("Lily's
 * recital went well" vs "lily's recital went really well") but rejects quotes the caller
 * never said.
 */

export const EVIDENCE_MATCH_THRESHOLD = 0.8;
export const MAX_FACTS_PER_CALL = 10;
export const MAX_FOLLOWUPS_PER_CALL = 3;
export const SCAM_TURN_THRESHOLD = 0.7;
export const REDACTED_BY_CALLER = "[forgotten at the caller's request]";
export const REDACTED_BY_FAMILY = "[forgotten at the family's request]";
export const FACT_CATEGORIES = [
  "person",
  "preference",
  "event",
  "routine",
  "interest",
  "health_mention",
  "other",
] as const;

export type WriterTurn = {
  idx: number;
  speaker: "user" | "assistant";
  text: string;
  redacted: boolean;
  scamScore?: number;
};
export type WriterFact = {
  id: string;
  text: string;
  category: string;
  evidence: string;
};
export type WriterFollowup = {
  id: string;
  speakable: string;
  notBefore: number;
  status: "open" | "asked" | "closed";
};

/** The model's structured output (§11.5), as parsed. Everything is re-checked in code. */
export type WriterOutput = {
  summary: string;
  facts_add: { text: string; category: string; evidence: string }[];
  facts_supersede: { factId: string; newText: string; evidence: string }[];
  followups_add: { speakable: string; notBefore: string }[];
  followups_close: string[];
  followups_reschedule: { followupId: string; notBefore: string }[];
  mood_note: string | null;
  mood_evidence: string | null;
  settings: {
    preferredName: string | null;
    chatTranscripts: boolean | null;
    moodNotes: boolean | null;
    evidence: string | null;
  };
};

export const WRITER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "facts_add",
    "facts_supersede",
    "followups_add",
    "followups_close",
    "followups_reschedule",
    "mood_note",
    "mood_evidence",
    "settings",
  ],
  properties: {
    summary: { type: "string" },
    facts_add: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "category", "evidence"],
        properties: {
          text: { type: "string" },
          category: { type: "string", enum: [...FACT_CATEGORIES] },
          evidence: { type: "string" },
        },
      },
    },
    facts_supersede: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factId", "newText", "evidence"],
        properties: {
          factId: { type: "string" },
          newText: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    followups_add: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speakable", "notBefore"],
        properties: {
          speakable: { type: "string" },
          notBefore: { type: "string", format: "date" },
        },
      },
    },
    followups_close: { type: "array", items: { type: "string" } },
    followups_reschedule: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["followupId", "notBefore"],
        properties: {
          followupId: { type: "string" },
          notBefore: { type: "string", format: "date" },
        },
      },
    },
    mood_note: { anyOf: [{ type: "string" }, { type: "null" }] },
    mood_evidence: { anyOf: [{ type: "string" }, { type: "null" }] },
    settings: {
      type: "object",
      additionalProperties: false,
      required: ["preferredName", "chatTranscripts", "moodNotes", "evidence"],
      properties: {
        preferredName: { anyOf: [{ type: "string" }, { type: "null" }] },
        chatTranscripts: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        moodNotes: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        evidence: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
} as const;

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

function lcs(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = temp;
    }
  }
  return row[b.length];
}

/** Share of the evidence's words found in order in the turn (0..1). */
export function evidenceScore(evidence: string, turn: string): number {
  const e = words(evidence);
  const t = words(turn);
  if (!e.length || !t.length) return 0;
  if (e.length < 2 && t.join(" ") !== e.join(" ")) return 0;
  return lcs(e.slice(0, 200), t.slice(0, 2000)) / e.length;
}

export function isFlagged(turn: WriterTurn): boolean {
  return (turn.scamScore ?? 0) >= SCAM_TURN_THRESHOLD;
}

/** The caller turn this evidence comes from, or null (MEM-7). */
export function matchCallerTurn(
  evidence: string,
  turns: WriterTurn[],
): WriterTurn | null {
  let best: WriterTurn | null = null;
  let bestScore = 0;
  for (const turn of turns) {
    if (turn.speaker !== "user" || turn.redacted) continue;
    const score = evidenceScore(evidence, turn.text);
    if (score > bestScore) {
      best = turn;
      bestScore = score;
    }
  }
  return bestScore >= EVIDENCE_MATCH_THRESHOLD ? best : null;
}

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** YYYY-MM-DD at local midnight in `timeZone`, as epoch ms. Null when unparsable. */
export function localMidnight(date: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(utc)) return null;
  try {
    // Offset of the zone at that moment: format the UTC instant in the zone and diff.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(utc));
    const get = (t: string) => +parts.find((p) => p.type === t)!.value;
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
    );
    return utc - (asUtc - utc);
  } catch {
    return utc;
  }
}

/** Today's date (YYYY-MM-DD) in `timeZone`. */
export function localDate(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export type ValidatedWrite = {
  summary: string;
  factsAdd: {
    text: string;
    category: string;
    evidence: string;
    turnIdx: number;
  }[];
  factsSupersede: {
    factId: string;
    newText: string;
    evidence: string;
    turnIdx: number;
  }[];
  followupsAdd: { speakable: string; notBefore: number }[];
  followupsClose: string[];
  followupsReschedule: { followupId: string; notBefore: number }[];
  moodNote: string | null;
  settings: {
    preferredName?: string;
    chatTranscripts?: boolean;
    moodNotes?: boolean;
  };
  dropped: string[];
};

/**
 * Apply every code-side rule to the model's output (§11.5 validation, §11.6 rules):
 * evidence must match a caller turn, scam-flagged turns give no facts (the writer input marks
 * every turn flagged by the classifier or at/after a scam hold), a quarantined call adds no
 * follow-ups,
 * at most 10 facts per call, ids must be ones we showed the model, mood notes only when the
 * caller shares them and only from their own words, settings only from their own words.
 */
export function validateWrite(
  raw: Partial<WriterOutput>,
  input: {
    turns: WriterTurn[];
    facts: WriterFact[];
    followups: WriterFollowup[];
    quarantined: boolean;
    timezone: string;
    now: number;
    moodNotesShared: boolean;
  },
): ValidatedWrite {
  const dropped: string[] = [];
  const turns = input.turns;
  const factIds = new Set(input.facts.map((f) => f.id));
  const followupIds = new Set(input.followups.map((f) => f.id));
  const existing = new Set(input.facts.map((f) => words(f.text).join(" ")));
  const today = localMidnight(localDate(input.now, input.timezone), input.timezone)!;

  const checkEvidence = (evidence: string, label: string) => {
    const turn = matchCallerTurn(evidence, turns);
    if (!turn) {
      dropped.push(`${label}: evidence matches no caller turn`);
      return null;
    }
    if (isFlagged(turn)) {
      dropped.push(`${label}: evidence is from a scam-flagged turn`);
      return null;
    }
    return turn;
  };

  let budget = MAX_FACTS_PER_CALL;
  const factsSupersede: ValidatedWrite["factsSupersede"] = [];
  const superseded = new Set<string>();
  for (const s of (raw.facts_supersede ?? []).slice(0, 50)) {
    const newText = clean(s?.newText, 300);
    const evidence = clean(s?.evidence, 500);
    const label = `supersede "${newText.slice(0, 60)}"`;
    if (!factIds.has(s?.factId) || superseded.has(s.factId)) {
      dropped.push(`${label}: unknown fact id`);
      continue;
    }
    if (!newText || !evidence) {
      dropped.push(`${label}: empty`);
      continue;
    }
    const turn = checkEvidence(evidence, label);
    if (!turn) continue;
    if (budget <= 0) {
      dropped.push(`${label}: over ${MAX_FACTS_PER_CALL} facts this call`);
      continue;
    }
    budget--;
    superseded.add(s.factId);
    factsSupersede.push({ factId: s.factId, newText, evidence, turnIdx: turn.idx });
  }

  const factsAdd: ValidatedWrite["factsAdd"] = [];
  for (const f of (raw.facts_add ?? []).slice(0, 50)) {
    const text = clean(f?.text, 300);
    const evidence = clean(f?.evidence, 500);
    const category = (FACT_CATEGORIES as readonly string[]).includes(f?.category)
      ? f.category
      : "other";
    const label = `fact "${text.slice(0, 60)}"`;
    if (!text || !evidence) {
      dropped.push(`${label}: empty`);
      continue;
    }
    const key = words(text).join(" ");
    if (existing.has(key)) {
      dropped.push(`${label}: already remembered`);
      continue;
    }
    const turn = checkEvidence(evidence, label);
    if (!turn) continue;
    if (budget <= 0) {
      dropped.push(`${label}: over ${MAX_FACTS_PER_CALL} facts this call`);
      continue;
    }
    budget--;
    existing.add(key);
    factsAdd.push({ text, category, evidence, turnIdx: turn.idx });
  }

  const date = (s: string, label: string) => {
    const at = localMidnight(String(s ?? ""), input.timezone);
    if (at === null) {
      dropped.push(`${label}: bad date`);
      return null;
    }
    return Math.max(at, today);
  };

  const followupsAdd: ValidatedWrite["followupsAdd"] = [];
  if (input.quarantined && (raw.followups_add ?? []).length)
    dropped.push("follow-ups: scam-quarantined call");
  else
    for (const f of (raw.followups_add ?? []).slice(0, 20)) {
      const speakable = clean(f?.speakable, 200);
      const label = `follow-up "${speakable.slice(0, 60)}"`;
      if (!speakable) continue;
      if (followupsAdd.length >= MAX_FOLLOWUPS_PER_CALL) {
        dropped.push(`${label}: over ${MAX_FOLLOWUPS_PER_CALL} follow-ups`);
        continue;
      }
      const at = date(f.notBefore, label);
      if (at !== null) followupsAdd.push({ speakable, notBefore: at });
    }

  const followupsClose = [...new Set(raw.followups_close ?? [])].filter((id) => {
    if (followupIds.has(id)) return true;
    dropped.push(`close follow-up: unknown id`);
    return false;
  });
  const closing = new Set(followupsClose);
  const followupsReschedule: ValidatedWrite["followupsReschedule"] = [];
  for (const r of raw.followups_reschedule ?? []) {
    if (!followupIds.has(r?.followupId) || closing.has(r.followupId)) {
      dropped.push("reschedule follow-up: unknown or closed id");
      continue;
    }
    const at = date(r.notBefore, "reschedule follow-up");
    if (at !== null) followupsReschedule.push({ followupId: r.followupId, notBefore: at });
  }

  // Settings (#69): only from the caller's own words in this call.
  const settings: ValidatedWrite["settings"] = {};
  const s = raw.settings;
  const wantsChange =
    !!s &&
    (s.preferredName != null || s.chatTranscripts != null || s.moodNotes != null);
  if (wantsChange) {
    const turn = s!.evidence ? matchCallerTurn(clean(s!.evidence, 500), turns) : null;
    if (!turn || isFlagged(turn)) dropped.push("settings: evidence matches no caller turn");
    else {
      const name = clean(s!.preferredName, 40);
      if (name && /^[\p{L}][\p{L} .'-]*$/u.test(name)) settings.preferredName = name;
      if (typeof s!.chatTranscripts === "boolean")
        settings.chatTranscripts = s!.chatTranscripts;
      if (typeof s!.moodNotes === "boolean") settings.moodNotes = s!.moodNotes;
    }
  }

  // Mood note (#76): caller's own statement, and only when they share mood notes.
  let moodNote: string | null = null;
  const note = clean(raw.mood_note, 300);
  if (note) {
    const shared = settings.moodNotes ?? input.moodNotesShared;
    const turn = raw.mood_evidence
      ? matchCallerTurn(clean(raw.mood_evidence, 500), turns)
      : null;
    if (!shared) dropped.push("mood note: caller has not agreed to share mood notes");
    else if (!turn || isFlagged(turn))
      dropped.push("mood note: evidence matches no caller turn");
    else moodNote = note;
  }

  return {
    summary: clean(raw.summary, 800),
    factsAdd,
    factsSupersede,
    followupsAdd,
    followupsClose,
    followupsReschedule,
    moodNote,
    settings,
    dropped,
  };
}

const STOP = new Set(
  (
    "a an the and or but i i'm im me my mine you your it its it's that this those these what " +
    "about said say says told tell forget forgetting don't dont do not please remember " +
    "anything something thing things just was were is are be been to of in on for with " +
    "at from her his him she he they them their we our us said earlier mentioned"
  ).split(" "),
);

function contentWords(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/'s$/, "").replace(/(?<=\w{3})s$/, "")),
  );
}

/** How well a forget request ("what I said about my neighbor") matches a text (0..1). */
export function forgetScore(description: string, text: string): number {
  const want = contentWords(description);
  if (!want.size) return 0;
  const have = contentWords(text);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.size;
}

export const FORGET_THRESHOLD = 0.5;

/** Facts a forget request refers to: everything scoring at least 0.5, best first. */
export function factsToForget<T extends { text: string; evidence: string }>(
  description: string,
  facts: T[],
): T[] {
  return facts
    .map((f) => ({
      f,
      score: Math.max(
        forgetScore(description, f.text),
        forgetScore(description, f.evidence),
      ),
    }))
    .filter((x) => x.score >= FORGET_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f);
}

/** A forget request itself ("forget what I said about...") is not content to redact. */
export function isForgetRequest(text: string): boolean {
  return /\b(forget|don'?t remember|do not remember|delete|erase)\b/i.test(text);
}

// ---------- consent (#63, #76) ----------

const YES =
  /^\s*(?:oh\s+|well\s+|um+\s+|uh+\s+)*(yes|yeah|yep|yup|sure|please|ok(ay)?|alright|all right|go ahead|do that|please do|that would be (nice|lovely|great|good|wonderful)|that'?d be (nice|lovely|great|good|wonderful)|i'?d (like|love) that|i would (like|love) that|absolutely|definitely|of course|why not)\b/i;
const NO = /\b(no|nope|nah|not|don'?t|do not|never|rather not|wouldn'?t)\b/i;
const OFFER =
  /\b(let|tell|ask|call|send|reach|pass)\b[^?]*\b(know|call|hear|message|ring|touch)\b[^?]*\?/i;

/** True when the caller's latest turn is a clear yes to an offer in the agent's turn before it. */
export function consentGiven(turns: { speaker: string; text: string }[]): boolean {
  const lastUser = turns.map((t) => t.speaker).lastIndexOf("user");
  if (lastUser < 1) return false;
  const answer = turns[lastUser].text;
  if (!YES.test(answer)) return false;
  // "yes, but don't tell her" is not a yes; a bare "no problem, yes" is rare enough to ask again.
  const afterYes = answer.replace(YES, "");
  if (NO.test(afterYes)) return false;
  const offer = turns
    .slice(0, lastUser)
    .reverse()
    .find((t) => t.speaker === "assistant");
  return !!offer && OFFER.test(offer.text);
}
