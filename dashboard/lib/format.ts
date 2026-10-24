/** Format integer cents as dollars using integer math only (no float rounding). */
export function formatCents(cents: number) {
  if (!Number.isFinite(cents)) return "—";
  const whole = Math.round(cents);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${String(rest).padStart(2, "0")}`;
}

function safeZone(timeZone?: string) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** "Oct 24, 10:24 AM" in the household's timezone. */
export function formatDateTime(at: number, timeZone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

export function formatTime(at: number, timeZone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(at));
}

/** Year-month key ("2026-10") of `at` in a timezone; matches the server (UTC if invalid). */
export function monthKey(at: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone) ?? "UTC",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(at));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

export function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 15)));
}

export function formatMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function formatDuration(startedAt: number, endedAt: number | null) {
  if (endedAt === null) return null;
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

/** Normalize a scam score to 0–1 (accepts 0–1 or 0–100 scales). */
export function scamFraction(score: number) {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const fraction = score > 1 ? score / 100 : score;
  return Math.min(1, fraction);
}

export function scamLevel(score: number): "clear" | "caution" | "high" {
  const f = scamFraction(score);
  if (f >= 0.7) return "high";
  if (f >= 0.3) return "caution";
  return "clear";
}

export function titleCase(value: string) {
  return value
    .split("_")
    .map((w, i) => (i === 0 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Parse "50", "$1,250.5" or "12.34" into integer cents without float math; null if invalid. */
export function parseDollars(text: string): number | null {
  const m = text
    .trim()
    .replace(/[$,\s]/g, "")
    .match(/^(\d{1,7})(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Cents as an editable dollar string ("50.00"). */
export function centsToInput(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
