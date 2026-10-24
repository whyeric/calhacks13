"use client";

// Milestone 7 stretch settings: #71 favorite suggestions, #60 check-in calls, #65 spoken PIN.
import { useQuery } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/format";
import { useAccessArgs } from "./access";
import { useFamilyAction } from "./family";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  type Tone,
} from "./ui";

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40";

export function StretchCards() {
  return (
    <>
      <SuggestionsCard />
      <CheckinsCard />
      <PinCard />
    </>
  );
}

/** #71: items ordered again and again, offered to the family as new favorites. */
function SuggestionsCard() {
  const suggestions = useQuery(api.favoriteSuggestions.list, useAccessArgs());
  const accept = useFamilyAction(api.favoriteSuggestions.accept);
  return (
    <Card title="Suggested favorites">
      <p className="mb-4 text-base text-muted">
        Items paid for in three or more orders. Adding one lets the caller say
        “my usual …” for it.
      </p>
      {suggestions === undefined ? (
        <Loading />
      ) : suggestions.length === 0 ? (
        <Empty>No suggestions yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {suggestions.map((s) => (
            <li
              key={s.storeItemId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3"
            >
              <div>
                <p className="text-lg font-semibold">{s.name}</p>
                <p className="text-base text-muted">
                  {s.orders} orders at {s.store} · usually {s.usualQty} · “
                  {s.aliases.join("”, “")}”
                </p>
              </div>
              <Button
                variant="primary"
                disabled={accept.pending || !accept.ready}
                onClick={() => accept.call({ storeItemId: s.storeItemId })}
              >
                Add favorite
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText>{accept.error}</ErrorText>
    </Card>
  );
}

const CHECKIN_TONE: Record<string, Tone> = {
  queued: "neutral",
  ringing: "warn",
  answered: "good",
  no_answer: "neutral",
  failed: "danger",
  cancelled: "neutral",
};

/** #60: outbound check-in calls driven by memory. */
function CheckinsCard() {
  const overview = useQuery(api.checkins.overview, useAccessArgs());
  const callNow = useFamilyAction(api.checkins.requestNow);
  const configure = useFamilyAction(api.checkins.configure);
  if (overview === undefined)
    return (
      <Card title="Check-in calls">
        <Loading />
      </Card>
    );
  const optedOut = overview.optedOutAt !== null;
  return (
    <Card
      title="Check-in calls"
      action={
        <Badge tone={overview.enabled ? "good" : "neutral"}>
          {overview.enabled ? `Every ${overview.everyDays} days` : "Off"}
        </Badge>
      }
    >
      <p className="mb-4 text-base text-muted">
        Errand Line calls to check in: it asks if now is a good time, then
        offers the usual item and one thing to follow up on. Voicemail never
        hears anything private.
      </p>
      {optedOut && (
        <p className="mb-4 rounded-xl border border-warn/40 bg-warn-soft p-3 text-base text-warn">
          The caller asked not to get check-in calls
          {overview.optedOutAt
            ? ` (${formatDateTime(overview.optedOutAt)})`
            : ""}
          . Only turn them back on if they’ve said they want them.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          disabled={callNow.pending || !callNow.ready || optedOut}
          onClick={() => callNow.call({})}
        >
          {callNow.pending ? "Calling…" : "Check in now"}
        </Button>
        <Button
          disabled={configure.pending || !configure.ready}
          onClick={() =>
            configure.call({
              enabled: !overview.enabled,
              everyDays: overview.everyDays,
              ...(optedOut && !overview.enabled ? { callerAgreed: true } : {}),
            })
          }
        >
          {overview.enabled
            ? "Stop weekly check-ins"
            : optedOut
              ? "Caller agreed: resume weekly"
              : "Check in weekly"}
        </Button>
      </div>
      <ErrorText>{callNow.error ?? configure.error}</ErrorText>
      {overview.recent.length > 0 && (
        <ul className="mt-4 space-y-2">
          {overview.recent.map((c) => (
            <li key={c._id} className="flex flex-wrap items-center gap-2">
              <Badge tone={CHECKIN_TONE[c.status] ?? "neutral"}>
                {c.status.replace("_", " ")}
              </Badge>
              <span className="text-base text-muted">
                {formatDateTime(c.createdAt)} ·{" "}
                {c.trigger === "manual" ? c.requestedBy : "schedule"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** #65: spoken PIN for calls from a new number. The PIN itself is never shown. */
function PinCard() {
  const status = useQuery(api.pin.status, useAccessArgs());
  const setPin = useFamilyAction(api.pin.setPin);
  const clearPin = useFamilyAction(api.pin.clearPin);
  const [pin, setPinText] = useState("");
  const [numbers, setNumbers] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const pinId = useId();
  const numbersId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = numbers
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (!pin && list.length === 0)
      return setProblem("Enter a new PIN, approved numbers, or both.");
    if (pin && !/^\d{4,8}$/.test(pin))
      return setProblem("The PIN must be 4 to 8 digits.");
    setProblem(null);
    const done = await setPin.call({
      ...(pin ? { pin } : {}),
      ...(list.length ? { numbers: list } : {}),
    });
    if (done !== undefined) {
      setPinText("");
      setNumbers("");
    }
  };

  return (
    <Card
      title="PIN for new numbers"
      action={
        status && (
          <Badge tone={status.pinSet ? "good" : "neutral"}>
            {status.pinSet ? "PIN set" : "No PIN"}
          </Badge>
        )
      }
    >
      <p className="mb-4 text-base text-muted">
        When the caller rings from one of these numbers, Errand Line asks for
        the PIN out loud before it can order. Three wrong tries lock the number
        for an hour and call you. The PIN is never stored or shown in plain
        text.
      </p>
      {status && status.numbers.length > 0 && (
        <p className="mb-3 text-base">
          Approved numbers: {status.numbers.map((n) => n.label).join(", ")}
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor={pinId} className="block text-base font-semibold">
            New PIN (4–8 digits)
          </label>
          <input
            id={pinId}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPinText(e.target.value.replace(/\D/g, ""))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={numbersId} className="block text-base font-semibold">
            Approved numbers (replace the list)
          </label>
          <input
            id={numbersId}
            placeholder="+14155550177"
            value={numbers}
            onChange={(e) => setNumbers(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="primary"
            disabled={setPin.pending || !setPin.ready}
          >
            Save PIN settings
          </Button>
          {status?.pinSet && (
            <Button
              disabled={clearPin.pending || !clearPin.ready}
              onClick={() => clearPin.call({})}
            >
              Turn off PIN calls
            </Button>
          )}
        </div>
        <ErrorText>{problem ?? setPin.error ?? clearPin.error}</ErrorText>
      </form>
    </Card>
  );
}
