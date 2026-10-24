import type { PinKind } from "../convex/venues/calhacks";

export type Pin = {
  id: string;
  name: string;
  kind: PinKind;
  x: number;
  y: number;
  description?: string;
  source: "seed" | "ai" | "user";
};

export type DataStatus = "live" | "connecting" | "offline-preview";
