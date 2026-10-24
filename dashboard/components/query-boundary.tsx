"use client";

import { ConvexError } from "convex/values";
import { Component, type ReactNode } from "react";
import { useAccess } from "./access";

function messageOf(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === "string")
    return error.data;
  return error instanceof Error ? error.message : String(error);
}

const KEY_REJECTED = /Invalid access key|Unauthenticated|Forbidden/;

/** Plain-language text for a query error; never echoes request arguments. */
function explain(message: string) {
  if (/Dashboard access is not configured/.test(message))
    return "The dashboard key isn't set up on the server yet. Set DASHBOARD_ACCESS_KEY (32+ characters) in the Convex deployment, then reload.";
  if (/No household/.test(message))
    return "No household has been set up yet. Run the demo seed first.";
  if (/DASHBOARD_HOUSEHOLD_PHONE/.test(message))
    return "More than one household exists. Set DASHBOARD_HOUSEHOLD_PHONE in the Convex deployment to choose one.";
  return message.replace(/^(\[[^\]]*\]\s*)+/, "");
}

class Boundary extends Component<
  {
    children: ReactNode;
    fallback?: ReactNode;
    onKeyRejected: (message: string) => void;
  },
  { message: string | null }
> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { message: messageOf(error) };
  }
  componentDidCatch(error: unknown) {
    if (KEY_REJECTED.test(messageOf(error)))
      this.props.onKeyRejected(
        "That access key did not work. Please check it and try again.",
      );
  }
  render() {
    const { message } = this.state;
    if (message === null) return this.props.children;
    // The gate is about to show the key form; don't flash an error first.
    if (KEY_REJECTED.test(message)) return null;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div
        role="alert"
        className="rounded-2xl border border-danger/40 bg-danger-soft p-6 text-lg text-danger"
      >
        <p className="font-semibold">Something went wrong loading this page.</p>
        <p className="mt-2 break-words text-base">{explain(message)}</p>
        <button
          type="button"
          onClick={() => this.setState({ message: null })}
          className="mt-4 rounded-lg border border-danger/40 px-4 py-2 font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-danger/40"
        >
          Try again
        </button>
      </div>
    );
  }
}

/** Shows query errors in place; a rejected access key returns to the gate. */
export function QueryBoundary({
  children,
  fallback,
}: {
  children: ReactNode;
  /** Rendered instead of the error panel (for small header widgets). */
  fallback?: ReactNode;
}) {
  const { forget } = useAccess();
  return (
    <Boundary onKeyRejected={forget} fallback={fallback}>
      {children}
    </Boundary>
  );
}
