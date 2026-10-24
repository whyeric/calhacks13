"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

const STORAGE_KEY = "errand-line.dashboard-access-key";
const ACTOR_KEY = "errand-line.dashboard-actor";

type AccessState = {
  accessKey: string;
  forget: (message?: string) => void;
  /** The family member using this device (a contact name), for approvals and edits. */
  actor: string | null;
  setActor: (name: string | null) => void;
};

const AccessContext = createContext<AccessState | null>(null);

function readStored(key = STORAGE_KEY) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(value: string | null, key = STORAGE_KEY) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode); the key lives in memory for this tab.
  }
}

/** Arguments every dashboard query needs. */
export function useAccessArgs() {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccessArgs outside AccessGate");
  const { accessKey } = ctx;
  return useMemo(() => ({ accessKey }), [accessKey]);
}

/**
 * Arguments every dashboard mutation needs: the access key plus who is acting. `ready` is
 * false until a family member is chosen (the server refuses a mutation without one).
 */
export function useActorArgs() {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useActorArgs outside AccessGate");
  const { accessKey, actor } = ctx;
  return useMemo(
    () => ({
      args: { accessKey, ...(actor ? { actor } : {}) },
      ready: actor !== null,
    }),
    [accessKey, actor],
  );
}

export function useAccess() {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess outside AccessGate");
  return ctx;
}

/**
 * Reads a key handed over in the link (`#key=…`, preferred because fragments
 * never reach a server or a Referer header, or the older `?key=…`) and strips
 * it from the address bar and history entry straight away.
 */
function takeKeyFromUrl() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const fromHash = hash.get("key")?.trim();
  const fromQuery = url.searchParams.get("key")?.trim();
  if (!hash.has("key") && !url.searchParams.has("key")) return null;
  hash.delete("key");
  url.searchParams.delete("key");
  url.hash = hash.toString();
  // Next.js syncs its router with history.replaceState, so this is safe.
  window.history.replaceState(window.history.state, "", url.toString());
  return fromHash || fromQuery || null;
}

/**
 * Holds the family's dashboard access key: from a shared link (once, then
 * stripped from the address bar) or typed in, remembered on this device.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actor, setActorState] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = takeKeyFromUrl();
    if (fromUrl) writeStored(fromUrl);
    // Browser-only state is read after mount to avoid a hydration mismatch.
    setAccessKey(fromUrl || readStored());
    setActorState(readStored(ACTOR_KEY));
    setReady(true);
  }, []);

  const setActor = useCallback((name: string | null) => {
    writeStored(name, ACTOR_KEY);
    setActorState(name);
  }, []);

  const forget = useCallback((message?: string) => {
    writeStored(null);
    setAccessKey(null);
    setNotice(message ?? null);
  }, []);

  const value = useMemo(
    () => (accessKey ? { accessKey, forget, actor, setActor } : null),
    [accessKey, forget, actor, setActor],
  );

  if (!ready) {
    return (
      <div
        className="grid min-h-dvh place-items-center text-xl text-muted"
        aria-live="polite"
      >
        Loading…
      </div>
    );
  }
  if (!value) {
    return (
      <KeyForm
        notice={notice}
        onSubmit={(key) => {
          writeStored(key);
          setNotice(null);
          setAccessKey(key);
        }}
      />
    );
  }
  return (
    <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
  );
}

function KeyForm({
  notice,
  onSubmit,
}: {
  notice: string | null;
  onSubmit: (key: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (key) onSubmit(key);
  };
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-2xl border border-line bg-surface p-8 shadow-sm"
      >
        <p className="text-sm font-semibold uppercase tracking-wider text-accent">
          Errand Line
        </p>
        <h1 className="mt-2 text-3xl font-bold">Family dashboard</h1>
        <p className="mt-3 text-lg text-muted">
          Enter the family access key to see calls, orders and alerts.
        </p>
        {notice && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-lg text-danger"
          >
            {notice}
          </p>
        )}
        <label
          htmlFor="access-key"
          className="mt-6 block text-lg font-semibold"
        >
          Access key
        </label>
        <input
          id="access-key"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-2 w-full rounded-lg border border-line bg-canvas px-4 py-3 text-lg outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
        />
        <button
          type="submit"
          className="mt-6 w-full rounded-lg bg-accent px-5 py-3 text-lg font-semibold text-on-accent hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
        >
          Open dashboard
        </button>
        <p className="mt-4 text-base text-muted">
          The key is remembered on this device only.
        </p>
      </form>
    </main>
  );
}
