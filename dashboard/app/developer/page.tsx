import type { Metadata } from "next";
import { Developer } from "@/components/developer";

export const metadata: Metadata = { title: "Developer" };

export default function Page() {
  return <Developer />;
}
