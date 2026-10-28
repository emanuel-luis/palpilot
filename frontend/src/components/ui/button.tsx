import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

// Every action in the console goes through this. Icon + label is the default;
// icon-only is available but requires an aria-label, enforced below in dev.
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md",
    "text-sm font-medium transition-all duration-fast ease-out",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    "active:translate-y-px",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-signal text-signal-fg shadow-soft hover:brightness-110",
        secondary: "bg-surface-2 text-fg shadow-soft hover:bg-surface-2/70",
        ghost: "text-muted hover:bg-surface-2 hover:text-fg",
        outline: "border border-line bg-transparent text-fg hover:bg-surface-2",
        danger: "bg-danger/12 text-danger border border-danger/40 hover:bg-danger hover:text-white",
        // Status-neutral affirmative, e.g. "apply" once changes are pending.
        ok: "bg-ok/14 text-ok border border-ok/40 hover:bg-ok hover:text-white",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-5 text-base",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    if (import.meta.env.DEV && size === "icon" && !props["aria-label"] && !props.title) {
      console.warn("Button: icon-only buttons need an aria-label or title.");
    }
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        // A loading button is also disabled: the action is already running.
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";
export { buttonVariants };
