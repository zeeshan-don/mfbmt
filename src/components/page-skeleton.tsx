import clsx from "clsx";
import { Card } from "./ui";

function Bar({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("animate-pulse rounded bg-elevated", className)} />;
}

function TableRows({ rows }: { rows: number }) {
  return (
    <div className="divide-y divide-line">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Bar className="h-3.5 w-3/4" />
            <Bar className="h-2.5 w-1/2" />
          </div>
          <Bar className="h-3.5 w-2/3" />
          <Bar className="h-3.5 w-1/2" />
          <Bar className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton({
  variant = "table",
  rows = 6,
}: {
  variant?: "table" | "dashboard";
  rows?: number;
}) {
  return (
    <div className="space-y-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>

      <div className="border-b border-line pb-5">
        <Bar className="h-2.5 w-28" />
        <Bar className="mt-3 h-7 w-52 max-w-full" />
        <Bar className="mt-2 h-3.5 w-80 max-w-full" />
      </div>

      {variant === "dashboard" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="p-4">
              <Bar className="h-2.5 w-24" />
              <Bar className="mt-3 h-7 w-16" />
              <Bar className="mt-2 h-2.5 w-28" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Bar key={index} className="h-8 w-24 rounded-control" />
          ))}
        </div>
      )}

      <Card>
        <div className="border-b border-line px-4 py-3">
          <Bar className="h-4 w-40" />
          <Bar className="mt-2 h-3 w-64 max-w-full" />
        </div>
        <TableRows rows={rows} />
      </Card>
    </div>
  );
}
