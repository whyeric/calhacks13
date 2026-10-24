import { useMemo, useState, type CSSProperties } from "react";
import MapView from "./MapView";
import { KIND_META, type PinKind, type Venue } from "../convex/venues/calhacks";
import type { DataStatus, Pin } from "./types";

type Props = { venue: Venue; pins: Pin[]; status: DataStatus };

const STATUS_LABEL: Record<DataStatus, string> = {
  live: "Live",
  connecting: "Connecting…",
  "offline-preview": "Preview",
};

export default function App({ venue, pins, status }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PinKind | "all">("all");
  const [picked, setPicked] = useState<{ x: number; y: number } | null>(null);
  const editMode = useMemo(() => new URLSearchParams(location.search).has("edit"), []);

  const kindsPresent = useMemo(
    () => (Object.keys(KIND_META) as PinKind[]).filter((k) => pins.some((p) => p.kind === k)),
    [pins],
  );
  const visible = filter === "all" ? pins : pins.filter((p) => p.kind === filter);
  const selected = pins.find((p) => p.id === selectedId) ?? null;

  const onPick = (x: number, y: number) => {
    setPicked({ x, y });
    navigator.clipboard?.writeText(`x: ${x}, y: ${y}`).catch(() => {});
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__name">Campus Pulse</span>
          <span className="brand__venue">{venue.name}</span>
        </div>
        <span className={`status status--${status}`}>
          <span className="status__dot" />
          {STATUS_LABEL[status]}
        </span>
      </header>

      <nav className="chips" aria-label="Filter pins">
        <button className={`chip chip--all${filter === "all" ? " chip--on" : ""}`} onClick={() => setFilter("all")}>
          All
        </button>
        {kindsPresent.map((k) => (
          <button
            key={k}
            className={`chip${filter === k ? " chip--on" : ""}`}
            style={{ "--chip": KIND_META[k].color } as CSSProperties}
            onClick={() => setFilter(filter === k ? "all" : k)}
          >
            <span aria-hidden>{KIND_META[k].emoji}</span> {KIND_META[k].label}
          </button>
        ))}
      </nav>

      <MapView
        width={venue.floorplan.width}
        height={venue.floorplan.height}
        pins={visible}
        selectedId={selectedId}
        onSelect={setSelectedId}
        editMode={editMode}
        onPick={onPick}
      />

      {editMode && (
        <div className="editbar">
          {picked ? (
            <>Copied <code>x: {picked.x}, y: {picked.y}</code>. Paste into the venue config.</>
          ) : (
            <>Edit mode: tap the map to get pin coordinates.</>
          )}
        </div>
      )}

      {selected && (
        <section className="sheet" aria-live="polite">
          <div className="sheet__head">
            <span className="sheet__badge" style={{ background: KIND_META[selected.kind].color }}>
              {KIND_META[selected.kind].emoji} {KIND_META[selected.kind].label}
            </span>
            <button className="sheet__close" onClick={() => setSelectedId(null)} aria-label="Close">
              ×
            </button>
          </div>
          <h2 className="sheet__title">{selected.name}</h2>
          {selected.description && <p className="sheet__desc">{selected.description}</p>}
          <p className="sheet__meta">Check-ins and live headcounts arrive in the next build.</p>
        </section>
      )}
    </div>
  );
}
