import { useEffect, useMemo } from "react";
import L from "leaflet";
import { ImageOverlay, MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import floorplanUrl from "./assets/floorplan.webp"; // top-down screenshot of the venue map
import { KIND_META } from "../convex/venues/calhacks";
import type { Pin } from "./types";

type Props = {
  width: number;
  height: number;
  pins: Pin[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  editMode: boolean;
  onPick: (x: number, y: number) => void;
};

// Floor-plan pixels (origin top-left) -> Leaflet CRS.Simple lat/lng (origin bottom-left).
const toLatLng = (x: number, y: number, h: number): L.LatLngExpression => [h - y, x];

function iconFor(pin: Pin, selected: boolean) {
  const meta = KIND_META[pin.kind];
  return L.divIcon({
    className: "pin-icon",
    html: `<div class="pin${selected ? " pin--selected" : ""}" style="--pin:${meta.color}">
             <span class="pin__emoji">${meta.emoji}</span>
           </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function FitOnce({ bounds }: { bounds: L.LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [8, 8] });
    map.setMinZoom(map.getZoom() - 0.5); // can't zoom out much past the whole venue
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function ClickHandler({ height, editMode, onPick, onSelect }: {
  height: number; editMode: boolean; onPick: Props["onPick"]; onSelect: Props["onSelect"];
}) {
  useMapEvents({
    click(e) {
      if (editMode) onPick(Math.round(e.latlng.lng), Math.round(height - e.latlng.lat));
      else onSelect(null);
    },
  });
  return null;
}

export default function MapView({ width, height, pins, selectedId, onSelect, editMode, onPick }: Props) {
  const bounds = useMemo<L.LatLngBoundsExpression>(() => [[0, 0], [height, width]], [width, height]);
  const maxBounds = useMemo<L.LatLngBoundsExpression>(
    () => [[-height * 0.25, -width * 0.25], [height * 1.25, width * 1.25]],
    [width, height],
  );

  return (
    <MapContainer
      className="map"
      crs={L.CRS.Simple}
      bounds={bounds}
      maxBounds={maxBounds}
      maxBoundsViscosity={0.8}
      zoomSnap={0.25}
      zoomControl={false}
      attributionControl={false}
      minZoom={-4}
      maxZoom={2}
    >
      <FitOnce bounds={bounds} />
      <ImageOverlay url={floorplanUrl} bounds={bounds} />
      <ClickHandler height={height} editMode={editMode} onPick={onPick} onSelect={onSelect} />
      {pins.map((p) => (
        <Marker
          key={p.id}
          position={toLatLng(p.x, p.y, height)}
          icon={iconFor(p, p.id === selectedId)}
          zIndexOffset={p.id === selectedId ? 1000 : 0}
          eventHandlers={{ click: () => onSelect(p.id) }}
          title={p.name}
          alt={p.name}
          keyboard
        />
      ))}
    </MapContainer>
  );
}
