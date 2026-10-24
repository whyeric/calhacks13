import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Card>
        <Link
          href="/live"
          className="text-lg font-semibold text-accent underline"
        >
          Go to Live calls
        </Link>
      </Card>
    </>
  );
}
