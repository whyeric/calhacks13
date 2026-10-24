import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { calhacks as venue } from "../convex/venues/calhacks";
import App from "./App";
import type { Pin } from "./types";
import "leaflet/dist/leaflet.css";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

// Live mode: pins come from Convex and update in real time.
function LiveApp() {
  const rows = useQuery(api.pins.list, { venueId: venue.id });
  const pins: Pin[] | undefined = rows?.map((r) => ({
    id: r._id,
    name: r.name,
    kind: r.kind,
    x: r.x,
    y: r.y,
    description: r.description,
    source: r.source,
  }));
  return <App venue={venue} pins={pins ?? []} status={rows === undefined ? "connecting" : "live"} />;
}

// Preview mode (no backend configured): pins come straight from the venue config.
function PreviewApp() {
  const pins: Pin[] = venue.pins.map((p) => ({ ...p, id: p.slug, source: "seed" }));
  return <App venue={venue} pins={pins} status="offline-preview" />;
}

const root = createRoot(document.getElementById("root")!);
if (convexUrl) {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <LiveApp />
      </ConvexProvider>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <PreviewApp />
    </StrictMode>,
  );
}
