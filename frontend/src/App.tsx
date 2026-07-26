import { useEffect, useRef, useState } from "react";
import { session, useSession } from "@/stores/session";
import { useHashRoute, navigate } from "@/hooks/useHashRoute";
import { LoginView } from "@/views/Login";
import { ConsoleView } from "@/views/Console";
import { UsersView } from "@/views/Users";
import { AccountView } from "@/views/Account";
import { Toaster } from "@/components/ui/Toast";
import { ConfirmHost } from "@/components/ui/Confirm";
import { deriveGameState } from "@/components/StatusPills";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { useOverview, useSaves, isOffline } from "@/hooks/queries";
import { apiGet } from "@/lib/api";
import { t } from "@/i18n/en";
import { getTheme } from "@/lib/theme";
import { DevSwitcher } from "@/components/DevSwitcher";

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

/** Shown while /api/session resolves permissions — shaped like the Console hero
 *  so the layout doesn't jump when the real content arrives. */
function BootSkeleton() {
  return (
    <>
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </>
  );
}

function StaleBanner() {
  const q = useOverview();
  const s = useSession();
  const failsRef = useRef(0);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!s.authed) { failsRef.current = 0; setStale(false); return; }
    // status 0 is a transport failure. A 401 must NOT count — that means the
    // session died, not that the data is stale.
    if (q.error || (q.data && !q.data.ok && q.data.status === 0)) {
      failsRef.current += 1;
      if (failsRef.current >= 2) setStale(true);
    } else if (q.data?.ok) {
      failsRef.current = 0; setStale(false);
    }
  }, [q.data, q.error, s.authed]);
  if (!stale) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn"
    >
      {t("header.staleData")}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const q = useOverview();
  const saves = useSaves();
  const body: any = (q.data?.data as any) || {};
  const vm = body.vm || {};
  const server = body.server;
  const gameState = deriveGameState(vm.status || "", !!server?.info);
  const activeSave = !isOffline(saves.data)
    ? (saves.data as any)?.slots?.find((x: any) => x.active)?.name
    : undefined;
  return (
    <>
      <AppShell
        vmStatus={vm.status || ""}
        gameState={gameState}
        serverName={server?.info?.servername}
        activeSave={activeSave}
      >
        <StaleBanner />
        {children}
      </AppShell>
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
  if (!s.ready) return <Shell><BootSkeleton /></Shell>;
  if (wantsUsers) {
    if (!mayUsers) return <Shell><BootSkeleton /></Shell>;
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
