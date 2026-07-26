import { useEffect, useRef, useState } from "react";
import { session, useSession } from "@/stores/session";
import { useHashRoute, navigate } from "@/hooks/useHashRoute";
import { LoginView } from "@/views/Login";
import { ConsoleView } from "@/views/Console";
import { UsersView } from "@/views/Users";
import { AccountView } from "@/views/Account";
import { Toaster } from "@/components/ui/Toast";
import { ConfirmHost, confirm } from "@/components/ui/Confirm";
import { StatusPills, deriveGameState } from "@/components/StatusPills";
import { useOverview } from "@/hooks/queries";
import { apiGet, apiPost } from "@/lib/api";
import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";
import { getTheme, resolvedTheme, toggleTheme } from "@/lib/theme";
import { DevSwitcher } from "@/components/DevSwitcher";
import { toast } from "@/components/ui/Toast";

function useBootstrapSession() {
  const s = useSession();
  useEffect(() => {
    if (!s.authed) { session.markReady(); return; }
    (async () => {
      const r = await apiGet<{ user: string; perms: string[] }>("/api/session");
      if (r.ok) session.setPerms(r.data.user, r.data.perms);
      else session.markReady();
    })();
  }, [s.authed]);
}

function ThemeToggle() {
  const [, tick] = useState(0);
  const label = resolvedTheme() === "dark" ? t("header.themeLight") : t("header.themeDark");
  return (
    <button className="btn btn-ghost" aria-label={label} title={label} onClick={() => { toggleTheme(); tick((v) => v + 1); }}>
      {resolvedTheme() === "dark" ? "☀" : "☾"}
    </button>
  );
}

function AccountMenu() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);
  async function signOut() { await apiPost("/api/logout"); session.clear(); }
  async function signOutAll() {
    const ok = await confirm({ message: t("account.signOutAllConfirm"), confirmLabel: t("account.signOutAll"), danger: true });
    if (!ok) return;
    const r = await apiPost("/api/logout-all");
    if (r.ok) toast.ok(t("account.signOutAllDone"));
    session.clear();
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {s.user} ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">{t("header.signedInAs", { user: s.user })}</div>
          <button className="menu-item" role="menuitem" onClick={() => { navigate("/account"); setOpen(false); }}>{t("header.account")}</button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={signOut}>{t("header.signOut")}</button>
          <button className="menu-item" role="menuitem" onClick={signOutAll}>{t("header.signOutAll")}</button>
        </div>
      )}
    </div>
  );
}

function StaleBanner() {
  const q = useOverview();
  const s = useSession();
  const failsRef = useRef(0);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!s.authed) { failsRef.current = 0; setStale(false); return; }
    if (q.error || (q.data && !q.data.ok && q.data.status === 0)) {
      failsRef.current += 1;
      if (failsRef.current >= 2) setStale(true);
    } else if (q.data?.ok) {
      failsRef.current = 0; setStale(false);
    }
  }, [q.data, q.error, s.authed]);
  if (!stale) return null;
  return <div className="stale-banner" role="status" aria-live="polite">{t("header.staleData")}</div>;
}

function NavItem({ hash, label, active, onClick }: { hash: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <a href={`#${hash}`} className={cn("nav-item", active && "active")} onClick={(e) => { e.preventDefault(); onClick(); }}>
      {label}
    </a>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const route = useHashRoute();
  const q = useOverview();
  const vm = (q.data?.data as any)?.vm || { status: "" };
  const server = (q.data?.data as any)?.server;
  const gameState = deriveGameState(vm.status, !!server?.info);
  const canUsers = session.can("users");
  return (
    <>
      <div className="app">
        <header className="header">
          <div className="brand"><span className="brand-mark" aria-hidden />PalPilot</div>
          <div className="spacer" />
          <StatusPills vmStatus={vm.status} gameState={gameState} />
          <ThemeToggle />
          <AccountMenu />
        </header>
        <aside className="sidebar">
          <div className="nav-group">
            <div className="nav-group-title">{t("nav.groups.console")}</div>
            <NavItem hash="/console" label={t("nav.console")} active={route.startsWith("/console")} onClick={() => navigate("/console")} />
          </div>
          <div className="nav-group">
            <div className="nav-group-title">{t("nav.groups.admin")}</div>
            {canUsers && <NavItem hash="/users" label={t("nav.users")} active={route.startsWith("/users")} onClick={() => navigate("/users")} />}
            <NavItem hash="/account" label={t("nav.account")} active={route.startsWith("/account")} onClick={() => navigate("/account")} />
          </div>
        </aside>
        <main className="main">
          <StaleBanner />
          {children}
        </main>
      </div>
      <Toaster />
      <ConfirmHost />
      <DevSwitcher />
    </>
  );
}

function Router() {
  const route = useHashRoute();
  const s = useSession();
  // Permissions aren't known until /api/session answers, and can() is false until
  // then — so a reload on #/users must WAIT rather than be bounced to /console.
  const wantsUsers = route.startsWith("/users");
  const mayUsers = session.can("users");

  useEffect(() => { getTheme(); }, []);
  useEffect(() => {
    // Redirect as an effect, never during render.
    if (s.ready && wantsUsers && !mayUsers) navigate("/console");
  }, [s.ready, wantsUsers, mayUsers]);

  if (!s.authed) return <LoginView />;
  if (!s.ready) return <Shell><div className="empty">{t("common.loading")}</div></Shell>;
  if (wantsUsers) {
    if (!mayUsers) return <Shell><div className="empty">{t("common.loading")}</div></Shell>;
    return <Shell><UsersView /></Shell>;
  }
  if (route.startsWith("/account")) return <Shell><AccountView /></Shell>;
  return <Shell><ConsoleView /></Shell>;
}

export default function App() {
  // Runs regardless of route so perms resolve even on a deep link.
  useBootstrapSession();
  return <Router />;
}
