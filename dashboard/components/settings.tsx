"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { centsToInput, formatCents, parseDollars } from "@/lib/format";
import { useAccessArgs } from "./access";
import { ChooseMemberNotice, useFamilyAction } from "./family";
import { StretchCards } from "./stretch-settings";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  PageHeader,
} from "./ui";

type Household = FunctionReturnType<typeof api.dashboard.household>;
type Favorite = Household["favorites"][number];
type Contact = Household["familyContacts"][number];

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-base font-semibold">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

const splitList = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function Settings() {
  const args = useAccessArgs();
  const household = useQuery(api.dashboard.household, args);
  const probe = useFamilyAction(api.households.setSharing);
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Changes apply to the very next order Errand Line places."
      />
      {household === undefined ? (
        <Loading />
      ) : (
        <>
          {!probe.ready && (
            <div className="mb-6">
              <ChooseMemberNotice />
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            <LimitsCard household={household} />
            <SharingCard household={household} />
            <FavoritesCard household={household} />
            <ContactsCard household={household} />
            <StretchCards />
          </div>
        </>
      )}
    </>
  );
}

function Saved({ show }: { show: boolean }) {
  return (
    <span role="status" className="text-base font-semibold text-accent">
      {show ? "✓ Saved" : ""}
    </span>
  );
}

function useFlash() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), 2500);
    return () => window.clearTimeout(t);
  }, [on]);
  return [on, () => setOn(true)] as const;
}

function LimitsCard({ household }: { household: Household }) {
  const limits = household.limits;
  const save = useFamilyAction(api.households.updateLimits);
  const [cap, setCap] = useState(
    limits ? centsToInput(limits.perOrderCapCents) : "",
  );
  const [budget, setBudget] = useState(
    limits ? centsToInput(limits.monthlyBudgetCents) : "",
  );
  const [stores, setStores] = useState(limits?.approvedStores.join(", ") ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, flash] = useFlash();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const capCents = parseDollars(cap);
    const budgetCents = parseDollars(budget);
    if (capCents === null || budgetCents === null)
      return setProblem("Enter amounts in dollars, like 50 or 50.00.");
    const list = splitList(stores);
    if (list.length === 0)
      return setProblem("Add at least one approved store.");
    setProblem(null);
    const done = await save.call({
      perOrderCapCents: capCents,
      monthlyBudgetCents: budgetCents,
      approvedStores: list,
    });
    if (done) flash();
  };

  return (
    <Card title="Spending limits" action={<Saved show={saved} />}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Per-order limit ($)"
            hint="Bigger orders ask the family first."
          >
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field
            label="Monthly budget ($)"
            hint="Paid and in-flight orders count."
          >
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </div>
        <Field
          label="Approved stores"
          hint="Separate with commas. Other stores ask the family first."
        >
          {(id) => (
            <input
              id={id}
              value={stores}
              onChange={(e) => setStores(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        {limits && (
          <p className="text-base text-muted">
            Now: {formatCents(limits.perOrderCapCents)} per order,{" "}
            {formatCents(limits.monthlyBudgetCents)} a month, at{" "}
            {limits.approvedStores.join(", ") || "no stores"}.
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={save.pending || !save.ready}
        >
          {save.pending ? "Saving…" : "Save limits"}
        </Button>
        <ErrorText>{problem ?? save.error}</ErrorText>
      </form>
    </Card>
  );
}

function Toggle({
  label,
  description,
  on,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p id={id} className="text-lg font-semibold">
          {label}
        </p>
        <p className="text-base text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-9 w-16 shrink-0 rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40 disabled:opacity-50 ${
          on ? "border-accent bg-accent" : "border-line bg-surface-2"
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-1 h-6 w-6 rounded-full bg-surface shadow transition-[left] ${
            on ? "left-8" : "left-1"
          }`}
        />
        <span className="sr-only">{on ? "Shared" : "Private"}</span>
      </button>
    </div>
  );
}

function SharingCard({ household }: { household: Household }) {
  const save = useFamilyAction(api.households.setSharing);
  const name = household.preferredName;
  const change = (key: "chatTranscripts" | "moodNotes", next: boolean) => {
    // §14.2: chat transcripts and mood notes are the caller's choice.
    if (
      next &&
      !window.confirm(
        `Only turn this on if ${name} has agreed to share it. ${name} can also change it by asking Errand Line.`,
      )
    )
      return;
    void save.call({ [key]: next });
  };
  return (
    <Card title="What the family sees">
      <div className="divide-y divide-line">
        <Toggle
          label="Chat transcripts"
          description="Full text of chat-only calls. Off: only the one-line summary."
          on={household.sharing.chatTranscripts}
          disabled={save.pending || !save.ready}
          onChange={(v) => change("chatTranscripts", v)}
        />
        <Toggle
          label="Mood notes"
          description={`Short notes when ${name} mentions how they're feeling.`}
          on={household.sharing.moodNotes}
          disabled={save.pending || !save.ready}
          onChange={(v) => change("moodNotes", v)}
        />
      </div>
      <p className="mt-3 rounded-lg bg-surface-2 px-4 py-3 text-base">
        Always shared: orders, approvals, scam alerts and wellbeing emergencies,
        and transcripts of calls with an order or alert.
      </p>
      <ErrorText>{save.error}</ErrorText>
    </Card>
  );
}

function FavoriteForm({
  favorite,
  onDone,
}: {
  favorite?: Favorite;
  onDone: () => void;
}) {
  const save = useFamilyAction(api.households.saveFavorite);
  const [name, setName] = useState(favorite?.name ?? "");
  const [aliases, setAliases] = useState(favorite?.aliases.join(", ") ?? "");
  const [store, setStore] = useState(favorite?.store ?? "Walmart");
  const [itemId, setItemId] = useState(favorite?.storeItemId ?? "");
  const [qty, setQty] = useState(String(favorite?.usualQty ?? 1));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done = await save.call({
      ...(favorite ? { favoriteId: favorite._id } : {}),
      name,
      aliases: splitList(aliases),
      store,
      storeItemId: itemId,
      usualQty: Number(qty),
    });
    if (done) onDone();
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-line bg-surface-2/50 p-4"
    >
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field
        label="Other names"
        hint="What the caller might say, separated by commas."
      >
        {(id) => (
          <input
            id={id}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Store">
          {(id) => (
            <input
              id={id}
              required
              value={store}
              onChange={(e) => setStore(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Store item ID">
          {(id) => (
            <input
              id={id}
              required
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Usual quantity">
          {(id) => (
            <input
              id={id}
              type="number"
              min={1}
              max={20}
              required
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
      </div>
      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={save.pending}>
          {save.pending ? "Saving…" : favorite ? "Save" : "Add favorite"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorText>{save.error}</ErrorText>
    </form>
  );
}

function FavoritesCard({ household }: { household: Household }) {
  const remove = useFamilyAction(api.households.removeFavorite);
  const [editing, setEditing] = useState<Id<"favorites"> | "new" | null>(null);
  return (
    <Card
      title="Favorites"
      action={
        editing === null && remove.ready ? (
          <Button onClick={() => setEditing("new")}>Add</Button>
        ) : undefined
      }
    >
      {editing === "new" && <FavoriteForm onDone={() => setEditing(null)} />}
      {household.favorites.length === 0 ? (
        <Empty>No favorites yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {household.favorites.map((f) =>
            editing === f._id ? (
              <li key={f._id} className="py-3">
                <FavoriteForm favorite={f} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li
                key={f._id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-lg font-semibold break-words">{f.name}</p>
                  <p className="text-base text-muted">
                    {f.store} · usual qty {f.usualQty}
                  </p>
                  {f.aliases.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {f.aliases.map((a) => (
                        <Badge key={a}>“{a}”</Badge>
                      ))}
                    </p>
                  )}
                </div>
                {remove.ready && editing === null && (
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setEditing(f._id)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={remove.pending}
                      onClick={() => {
                        if (
                          window.confirm(`Remove “${f.name}” from favorites?`)
                        )
                          void remove.call({ favoriteId: f._id });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      <ErrorText>{remove.error}</ErrorText>
    </Card>
  );
}

function ContactForm({
  contact,
  index,
  onDone,
}: {
  contact?: Contact;
  index?: number;
  onDone: () => void;
}) {
  const save = useFamilyAction(api.households.saveContact);
  const [name, setName] = useState(contact?.name ?? "");
  const [relation, setRelation] = useState(contact?.relation ?? "");
  const [phone, setPhone] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done = await save.call({
      ...(contact && index !== undefined
        ? { index, currentName: contact.name }
        : {}),
      name,
      relation,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
    if (done !== undefined) onDone();
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-line bg-surface-2/50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Relation">
          {(id) => (
            <input
              id={id}
              required
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
      </div>
      <Field
        label={contact ? "New phone (leave blank to keep)" : "Phone"}
        hint="With country code, like +1 415 555 0101. Approval and scam alert calls ring this number."
      >
        {(id) => (
          <input
            id={id}
            type="tel"
            autoComplete="off"
            required={!contact}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={save.pending}>
          {save.pending ? "Saving…" : contact ? "Save" : "Add contact"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorText>{save.error}</ErrorText>
    </form>
  );
}

function ContactsCard({ household }: { household: Household }) {
  const remove = useFamilyAction(api.households.removeContact);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  return (
    <Card
      title="Family contacts"
      action={
        editing === null && remove.ready ? (
          <Button onClick={() => setEditing("new")}>Add</Button>
        ) : undefined
      }
    >
      {editing === "new" && <ContactForm onDone={() => setEditing(null)} />}
      <ul className="divide-y divide-line">
        {household.familyContacts.map((c, i) =>
          editing === i ? (
            <li key={`${c.name}-${i}`} className="py-3">
              <ContactForm
                contact={c}
                index={i}
                onDone={() => setEditing(null)}
              />
            </li>
          ) : (
            <li
              key={`${c.name}-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <p className="text-lg">
                <span className="font-semibold">{c.name}</span>{" "}
                <span className="text-muted">
                  · {c.relation} · phone ending {c.phoneLast4}
                </span>
              </p>
              {remove.ready && editing === null && (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setEditing(i)}>
                    Edit
                  </Button>
                  {household.familyContacts.length > 1 && (
                    <Button
                      variant="ghost"
                      disabled={remove.pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${c.name}? They will stop getting alert calls.`,
                          )
                        )
                          void remove.call({ index: i, currentName: c.name });
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </li>
          ),
        )}
      </ul>
      <p className="mt-3 text-base text-muted">
        Time zone: {household.timezone}
      </p>
      <ErrorText>{remove.error}</ErrorText>
    </Card>
  );
}
