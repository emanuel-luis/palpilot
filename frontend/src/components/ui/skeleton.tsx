import { cn } from "@/lib/cn";

/** Loading placeholder. Shaped like the content it replaces, so the layout
 *  doesn't jump when real data lands. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-surface-2", className)}
      aria-hidden
      {...props}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-linear-to-r from-transparent via-fg/5 to-transparent" />
    </div>
  );
}
