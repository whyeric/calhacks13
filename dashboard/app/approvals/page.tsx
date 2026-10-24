import type { Metadata } from "next";
import { Approvals } from "@/components/approvals";

export const metadata: Metadata = { title: "Approvals" };

export default function Page() {
  return <Approvals />;
}
