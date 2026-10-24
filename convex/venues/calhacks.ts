// Venue config: everything specific to one deployment lives here.
// A new venue (Berkeley, Yale) = a new file like this one, not new code.
//
// Coordinates are image pixels on the floor plan: (0,0) is the TOP-LEFT corner.
// To place pins on the real floor plan: open the app with ?edit=1, tap the map,
// and copy the x/y it shows into this file. Then run `npx convex run seed:run`.

export type PinKind =
  | "hacking"
  | "area"
  | "food"
  | "workshop"
  | "sponsor"
  | "stage"
  | "help"
  | "hardware"
  | "quiet"
  | "restroom";

export type SeedPin = {
  slug: string; // stable id, so re-seeding updates instead of duplicating
  name: string;
  kind: PinKind;
  x: number;
  y: number;
  description?: string;
};

export type Venue = {
  id: string;
  name: string;
  floorplan: { width: number; height: number }; // image lives at src/assets/floorplan.*
  pins: SeedPin[];
};

export const calhacks: Venue = {
  id: "calhacks-13",
  name: "Cal Hacks 13.0",
  // Floor plan = top-down screenshot of the venue's own indoor map (src/assets/floorplan.webp).
  // Pin positions were matched by hand from zoomed screenshots of that map; nudge with ?edit=1 if one is off.
  floorplan: { width: 796, height: 1744 },
  pins: [
    { slug: "main-stage", name: "Main stage", kind: "stage", x: 175, y: 190, description: "North end of the Atrium, by the green rooms. Opening and talks." },
    { slug: "atrium-tables", name: "Atrium hacking tables", kind: "hacking", x: 348, y: 513, description: "Main hacking floor." },
    { slug: "sponsors-atrium-west", name: "Sponsors: Atrium west wall", kind: "sponsor", x: 235, y: 425, description: "Booths 12 Annapurna, 13 Anthropic, 14 SpacetimeDB, 15 Creao, 16 Elastic, 17 Apify, 18 Armadin, 19 CRS Credit API, 20 Bright Data, 21 Convex, 22 Factory AI." },
    { slug: "sponsors-atrium-east", name: "Sponsors: Atrium east wall", kind: "sponsor", x: 440, y: 250, description: "Booths 1 Visa, 2 Fetch, 3 Microsoft, 4 Supercell." },
    { slug: "sponsors-atrium-south", name: "Sponsors: south Atrium", kind: "sponsor", x: 600, y: 495, description: "Booths 5 Red Bull, 6 Meta, 7 SpaceX AI, 8 Context.dev, 9 Bitdeer, 10 After Query, 11 Cartesia." },
    { slug: "sponsors-broadway", name: "Sponsors: Broadway", kind: "sponsor", x: 385, y: 685, description: "Booths 26 Moonpay, 27 Moss, 28 Coinbase, 29 Savvy, 30 a16z, 37 Capital One, 38 Listen Labs, 39 Notability, 41 Scale, 45 Hyphenate. 44 Asus and 47 Seeed are on the east side." },
    { slug: "restrooms", name: "Restrooms", kind: "restroom", x: 700, y: 800 },
    { slug: "mentor-tables", name: "Mentor tables", kind: "help", x: 440, y: 890, description: "Table 43." },
    { slug: "mezzanine-tables", name: "Mezzanine hacking tables", kind: "hacking", x: 565, y: 935 },
    { slug: "meeting-rooms", name: "Meeting rooms M6–M8", kind: "workshop", x: 712, y: 945, description: "M8: coffee chat." },
    { slug: "sponsors-mezzanine", name: "Sponsors: Mezzanine", kind: "sponsor", x: 500, y: 1078, description: "Booths 25 Capital One, 32 Engramme AI, 33 Greptile, 35 Figma." },
    { slug: "hardware", name: "Hardware, merch, 3D printers", kind: "hardware", x: 630, y: 1120 },
    { slug: "luggage", name: "Luggage storage", kind: "help", x: 650, y: 1400 },
    { slug: "food", name: "Food", kind: "food", x: 575, y: 1465, description: "Stanchion queue lines up here." },
    { slug: "box-office", name: "Box office", kind: "help", x: 500, y: 1555, description: "Check-in and questions." },
    { slug: "theater", name: "Theater", kind: "stage", x: 330, y: 1495 },
  ],
};

export const KIND_META: Record<PinKind, { label: string; emoji: string; color: string }> = {
  hacking: { label: "Hacking", emoji: "💻", color: "#1864ab" },
  area: { label: "Areas", emoji: "📍", color: "#495057" },
  food: { label: "Food", emoji: "🍕", color: "#e8590c" },
  workshop: { label: "Workshops", emoji: "🛠️", color: "#1971c2" },
  sponsor: { label: "Sponsors", emoji: "🎟️", color: "#7048e8" },
  stage: { label: "Stage", emoji: "🎤", color: "#c2255c" },
  help: { label: "Help", emoji: "❓", color: "#2b8a3e" },
  hardware: { label: "Hardware", emoji: "🔌", color: "#5c677d" },
  quiet: { label: "Quiet", emoji: "🌙", color: "#0b7285" },
  restroom: { label: "Restrooms", emoji: "🚻", color: "#0b7285" },
};
