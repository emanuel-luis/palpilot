import { useState, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Section({ title, children, defaultOpen = true, locked }: {
  title: string; children: ReactNode; defaultOpen?: boolean; locked?: string | false;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("panel", locked && "panel-locked")}>
      <button className="panel-header panel-header-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div className="panel-title">{title}</div>
        <span className="panel-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="panel-body">
          {locked ? <div className="empty">{locked}</div> : children}
        </div>
      )}
    </section>
  );
}
