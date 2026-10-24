"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState, type ReactNode } from "react";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  // Created lazily so builds without a Convex URL still prerender.
  const [client] = useState(() => (url ? new ConvexReactClient(url) : null));
  if (!client) {
    return (
      <main className="grid min-h-dvh place-items-center px-4">
        <p className="max-w-lg text-center text-xl">
          The dashboard is not connected to Convex. Set{" "}
          <code className="font-mono">NEXT_PUBLIC_CONVEX_URL</code> (or{" "}
          <code className="font-mono">CONVEX_URL</code> in{" "}
          <code className="font-mono">.env.local</code>) and restart.
        </p>
      </main>
    );
  }
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
