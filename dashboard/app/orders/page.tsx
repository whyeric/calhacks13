import type { Metadata } from "next";
import { Orders } from "@/components/orders";

export const metadata: Metadata = { title: "Orders" };

export default function Page() {
  return <Orders />;
}
