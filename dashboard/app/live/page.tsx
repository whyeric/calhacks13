import type { Metadata } from "next";
import { LiveCalls } from "@/components/live-calls";

export const metadata: Metadata = { title: "Live calls" };

export default function Page() {
  return <LiveCalls />;
}
