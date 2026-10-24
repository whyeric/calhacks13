import type { Metadata } from "next";
import { Memory } from "@/components/memory";

export const metadata: Metadata = { title: "Memory" };

export default function Page() {
  return <Memory />;
}
