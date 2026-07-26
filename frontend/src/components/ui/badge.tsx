import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Status hues are the only saturated colour on the page. A badge always carries
// TEXT as well as colour — a red dot and a green dot read identically to a lot
// of people.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase",
  {
    variants: {
      tone: {
        neutral: "border-line bg-surface-2 text-muted",
        ok: "border-ok/40 bg-ok/12 text-ok",
        warn: "border-warn/40 bg-warn/12 text-warn",
        danger: "border-danger/40 bg-danger/12 text-danger",
        info: "border-signal/40 bg-signal/12 text-signal",
        live: "border-ion/40 bg-ion/12 text-ion",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({ className, tone, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full bg-current", pulse && "animate-breathe")}
        />
      ) : null}
      {children}
    </span>
  );
}
