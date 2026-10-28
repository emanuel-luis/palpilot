import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/cn";

export const Tabs = TabsPrimitive.Root;

/** Horizontal, scrollable on narrow screens rather than wrapping into a block
 *  that pushes the content down. */
export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex w-full items-center gap-1 overflow-x-auto border-b border-line/60 pb-px",
        "scrollbar-thin",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative shrink-0 whitespace-nowrap rounded-t-md px-3 py-2 text-sm text-muted transition-colors duration-fast",
        "hover:text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        "data-[state=active]:text-fg data-[state=active]:font-medium",
        // Underline marks the active tab; colour alone wouldn't.
        "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full",
        "data-[state=active]:after:bg-signal",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("mt-4 focus-visible:outline-hidden animate-fade-up", className)}
      {...props}
    />
  );
}
