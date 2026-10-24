import type { Metadata } from "next";
import { Alerts } from "@/components/alerts";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return <Alerts />;
}
