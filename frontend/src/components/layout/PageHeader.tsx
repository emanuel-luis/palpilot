import { cn } from "@/lib/cn";

/** One heading per page, with room for a short description and actions. */
export function PageHeader({
  title, description, actions, className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Uniform "the VM is off" state. Not an error: it is the product's normal
 *  resting state, so it reads as information, never as a failure. */
export function OfflineNotice({ action }: { action: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/50 px-5 py-8 text-center">
      <p className="text-sm text-muted">Start the server to {action}.</p>
      <p className="mt-1 text-xs text-faint">
        Nothing is billing right now except the static IP and disks.
      </p>
    </div>
  );
}
