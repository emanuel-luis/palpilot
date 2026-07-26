import { ReactNode, useState } from "react";
import { cn } from "@/lib/cn";

interface Props {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  locked?: ReactNode;
  children?: ReactNode;
}

export function Section({ title, badge, defaultOpen = true, locked, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen((v) => !v)} role="button" aria-expanded={open} tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}>
        <span className={cn("chev", open && "open")} aria-hidden />
        <span className="section-title">{title}</span>
        <div className="spacer" />
        {badge && <span className="section-badge">{badge}</span>}
      </div>
      {open && (locked ? <div className="section-locked">{locked}</div> : <div className="section-body">{children}</div>)}
    </div>
  );
}
