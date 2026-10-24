"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReference } from "convex/server";
import { useCallback, useEffect, useId, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useAccess, useAccessArgs, useActorArgs } from "./access";

/** Plain text of a mutation error; never echoes request arguments. */
export function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === "string")
    return error.data;
  const text = error instanceof Error ? error.message : String(error);
  // Server errors arrive as "[CONVEX M(...)] [Request ID: ...] Server Error ... Uncaught ConvexError: X".
  const match = text.match(/ConvexError: ([^\n]+)/);
  return match ? match[1] : "That didn't work. Please try again.";
}

type AnyMutation = FunctionReference<"mutation">;

/**
 * Run a family mutation with the access key and the chosen family member added, tracking
 * pending state and a readable error. `ready` is false until someone is chosen.
 */
export function useFamilyAction<M extends AnyMutation>(mutation: M) {
  const run = useMutation(mutation);
  const { args, ready } = useActorArgs();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = useCallback(
    async (
      extra: Omit<M["_args"], "accessKey" | "actor" | "householdId">,
    ): Promise<M["_returnType"] | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await run({ ...args, ...extra } as M["_args"]);
      } catch (e) {
        setError(errorMessage(e));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [run, args],
  );
  return { call, pending, error, ready, clearError: () => setError(null) };
}

/**
 * "Who's using this?" Choose a family contact once per device; approvals, overrides and
 * edits are recorded under that name. With the shared demo key this is self-declared.
 */
export function FamilyMemberPicker({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const accessArgs = useAccessArgs();
  const household = useQuery(api.dashboard.household, accessArgs);
  const { actor, setActor } = useAccess();
  const names = household?.familyContacts.map((c) => c.name) ?? [];
  const known = actor !== null && names.includes(actor);

  // Forget a stored name that is no longer a contact; pick the only one automatically.
  useEffect(() => {
    if (!household) return;
    if (actor !== null && !names.includes(actor)) setActor(null);
    else if (actor === null && names.length === 1) setActor(names[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household, actor]);

  if (!household) return null;
  return (
    <div className={compact ? "flex items-center gap-2" : "space-y-2"}>
      <label
        htmlFor={id}
        className={
          compact ? "text-base text-muted" : "block text-lg font-semibold"
        }
      >
        {compact ? "You are" : "Which family member are you?"}
      </label>
      <select
        id={id}
        value={known ? actor! : ""}
        onChange={(e) => setActor(e.target.value || null)}
        className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
      >
        <option value="">Choose…</option>
        {household.familyContacts.map((c) => (
          <option key={`${c.name}-${c.phoneLast4}`} value={c.name}>
            {c.name} ({c.relation})
          </option>
        ))}
      </select>
    </div>
  );
}

/** Shown in place of action buttons until a family member is chosen. */
export function ChooseMemberNotice() {
  return (
    <div className="rounded-xl border border-warn/40 bg-warn-soft p-4 text-lg text-warn">
      <p className="mb-2 font-semibold">
        Choose who you are so your decision is recorded under your name.
      </p>
      <FamilyMemberPicker />
    </div>
  );
}
