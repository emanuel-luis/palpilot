import { useEffect, useMemo, useState } from "react";
import { useUsers, useRoles, useUpsertUser, useDeleteUser, useUpsertRole, useDeleteRole } from "@/hooks/queries";
import { session, useSession } from "@/stores/session";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/Confirm";
import { t } from "@/i18n/en";
import { cn } from "@/lib/cn";

const KNOWN_PERMS = ["view","power","saves","mods","settings","watchdog","commands","users"];

export function UsersView() {
  const s = useSession();
  const canUsers = session.can("users");
  const uq = useUsers();
  const rq = useRoles();
  const upsertU = useUpsertUser();
  const delU = useDeleteUser();
  const upsertR = useUpsertRole();
  const delR = useDeleteRole();

  const [editing, setEditing] = useState<string | null>(null);
  const [uname, setUname] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState("viewer");
  const [perms, setPerms] = useState<string[]>([]);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [roleName, setRoleName] = useState("");
  const [rolePerms, setRolePerms] = useState<string[]>([]);

  const users = uq.data?.users || [];
  const roles = rq.data?.roles || [];
  const allPerms = useMemo(() => uq.data?.all_perms || rq.data?.all_perms || KNOWN_PERMS, [uq.data, rq.data]);

  useEffect(() => {
    if (editing) {
      const u = users.find((x: any) => x.username === editing);
      if (u) { setUname(u.username); setPw(""); setRole(u.role || "viewer");
        setPerms(u.role === "custom" ? [...(u.effective_perms || u.perms || [])] : [...(u.perms || [])]); }
    }
  }, [editing]);
  useEffect(() => {
    if (editingRole) {
      const r = roles.find((x: any) => x.name === editingRole);
      if (r) { setRoleName(r.name); setRolePerms([...r.perms]); }
    }
  }, [editingRole]);

  // Switching an existing role-based user to "custom" must start from the
  // permissions they EFFECTIVELY hold. Their raw `perms` override is empty for
  // anyone whose access comes from a role, so seeding from it would silently
  // strip every permission on save.
  function changeRole(next: string) {
    setRole(next);
    if (next === "custom" && perms.length === 0) {
      const u = users.find((x: any) => x.username === (editing || uname));
      const seed: string[] = u?.effective_perms || u?.perms || [];
      if (seed.length) { setPerms([...seed]); toast.info(t("users.customSeeded")); }
    }
  }

  if (!canUsers) return <div className="empty">{t("users.noPermission")}</div>;

  async function saveUser() {
    if (!uname.trim()) { toast.err(t("users.needName")); return; }
    const isNew = !users.some((u: any) => u.username === uname);
    if (isNew && !pw) { toast.err(t("users.needPassword")); return; }
    const body: any = { username: uname.trim(), role };
    if (pw) body.password = pw;
    if (role === "custom") body.perms = perms;
    const r = await upsertU.mutateAsync(body);
    if (!r.ok) toast.err(r.error || t("users.saveFailed"));
    else { toast.ok(t("users.saved")); resetUserForm(); }
  }
  async function deleteUser(name: string) {
    if (name === s.user) { toast.err(t("users.cantDeleteSelf")); return; }
    const ok = await confirm({ message: t("users.confirmDelete", { name }), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    const r = await delU.mutateAsync(name);
    if (!r.ok) toast.err(r.error || t("users.deleteFailed"));
    else toast.ok(t("users.deleted"));
  }
  function resetUserForm() { setEditing(null); setUname(""); setPw(""); setRole("viewer"); setPerms([]); }

  async function saveRole() {
    if (!roleName.trim()) { toast.err(t("users.roles.needName")); return; }
    if (roleName === "custom") { toast.err(t("users.roles.reserved")); return; }
    const r = await upsertR.mutateAsync({ name: roleName.trim(), perms: rolePerms });
    if (!r.ok) toast.err(r.error || t("users.roles.saveFailed"));
    else { toast.ok(t("users.roles.saved")); setEditingRole(null); setRoleName(""); setRolePerms([]); }
  }
  async function deleteRole(name: string) {
    const r = roles.find((x: any) => x.name === name);
    if (r?.builtin) { toast.err(t("users.roles.cantDeleteBuiltin")); return; }
    if (users.some((u: any) => u.role === name)) { toast.err(t("users.roles.stillAssigned")); return; }
    const ok = await confirm({ message: t("users.roles.confirmDelete", { name }), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    const rr = await delR.mutateAsync(name);
    if (!rr.ok) toast.err(rr.error || t("users.roles.deleteFailed"));
    else toast.ok(t("users.roles.deleted"));
  }

  return (
    <div className="stack-lg">
      <h1>{t("users.title")}</h1>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{editing ? t("users.editTitle", { name: editing }) : t("users.addTitle")}</div></div>
        <div className="panel-body stack">
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label className="field-label">{t("users.username")}</label>
              <input className="input" value={uname} onChange={(e) => setUname(e.target.value)} disabled={!!editing} /></div>
            <div className="field" style={{ flex: 1 }}><label className="field-label">{editing ? t("users.passwordKeep") : t("users.password")}</label>
              <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div>
            <div className="field" style={{ flex: 1 }}><label className="field-label">{t("users.role")}</label>
              <select className="select" value={role} onChange={(e) => changeRole(e.target.value)}>
                {(uq.data?.roles || []).map((r: string) => <option key={r} value={r}>{r}</option>)}
                <option value="custom">{t("users.roles.customLabel")}</option>
              </select></div>
          </div>
          {role === "custom" && (
            <div className="field"><label className="field-label">{t("users.perms")}</label>
              <PermMatrix perms={perms} setPerms={setPerms} all={allPerms} /></div>
          )}
          <div className="row">
            <button className="btn btn-primary" onClick={saveUser} disabled={upsertU.isPending}>{t("users.save")}</button>
            {editing && <button className="btn" onClick={resetUserForm}>{t("common.cancel")}</button>}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("users.listTitle")}</div></div>
        <div className="panel-body"><div className="table-scroll"><table className="table">
          <thead><tr><th>{t("users.colUsername")}</th><th style={{ width: 140 }}>{t("users.colRole")}</th><th>{t("users.colPerms")}</th><th style={{ width: 180 }}>{t("users.colActions")}</th></tr></thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={4}><div className="empty">{t("users.noUsers")}</div></td></tr>}
            {users.map((u: any) => (
              <tr key={u.username}>
                <td><strong>{u.username}</strong>{u.username === s.user && <span className="field-hint" style={{ marginLeft: 6 }}>{t("users.you")}</span>}</td>
                <td><span className="pill">{u.role}</span></td>
                <td><div className="row-tight" style={{ flexWrap: "wrap", gap: 4 }}>
                  {(u.effective_perms || u.perms || []).map((p: string) => <span key={p} className="pill" style={{ fontSize: 11 }}>{permLabel(p)}</span>)}
                </div></td>
                <td><div className="row-tight">
                  <button className="btn btn-sm" onClick={() => setEditing(u.username)}>{t("common.edit")}</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteUser(u.username)} disabled={u.username === s.user}>{t("common.delete")}</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{editingRole ? t("users.roles.editTitle", { name: editingRole }) : t("users.roles.addTitle")}</div></div>
        <div className="panel-body stack">
          <p className="field-hint">{t("users.roles.hint")}</p>
          <div className="field" style={{ maxWidth: 320 }}><label className="field-label">{t("users.roles.name")}</label>
            <input className="input" value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder={t("users.roles.namePlaceholder")}
              disabled={!!editingRole && roles.find((r: any) => r.name === editingRole)?.builtin} /></div>
          <div className="field"><label className="field-label">{t("users.perms")}</label>
            <PermMatrix perms={rolePerms} setPerms={setRolePerms} all={allPerms} /></div>
          <div className="row">
            <button className="btn btn-primary" onClick={saveRole} disabled={upsertR.isPending}>{t("users.roles.save")}</button>
            {editingRole && <button className="btn" onClick={() => { setEditingRole(null); setRoleName(""); setRolePerms([]); }}>{t("common.cancel")}</button>}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-header"><div className="panel-title">{t("users.roles.title")}</div></div>
        <div className="panel-body"><div className="table-scroll"><table className="table">
          <thead><tr><th>{t("users.roles.colName")}</th><th>{t("users.roles.colPerms")}</th><th style={{ width: 180 }}>{t("users.colActions")}</th></tr></thead>
          <tbody>
            {roles.map((r: any) => (
              <tr key={r.name}>
                <td><strong>{r.name}</strong>{r.builtin && <span className="pill" style={{ fontSize: 11, marginLeft: 6 }}>{t("users.roles.builtin")}</span>}</td>
                <td><div className="row-tight" style={{ flexWrap: "wrap", gap: 4 }}>{r.perms.map((p: string) => <span key={p} className="pill" style={{ fontSize: 11 }}>{p}</span>)}</div></td>
                <td><div className="row-tight">
                  <button className="btn btn-sm" onClick={() => setEditingRole(r.name)}>{t("common.edit")}</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteRole(r.name)} disabled={r.builtin}>{t("common.delete")}</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      </div>
    </div>
  );
}

// A perm the server adds that this build doesn't know about degrades to its raw
// slug rather than vanishing from the matrix.
const LABELLED_PERMS = new Set([...KNOWN_PERMS, "config"]);
function permLabel(p: string): string {
  return LABELLED_PERMS.has(p) ? t(`users.perm.${p}` as any) : p;
}

function PermMatrix({ perms, setPerms, all }: { perms: string[]; setPerms: (p: string[]) => void; all: string[] }) {
  const list = all.filter((p) => p !== "config");
  const toggle = (p: string) => setPerms(perms.includes(p) ? perms.filter((x) => x !== p) : [...perms, p]);
  return (
    <div className="perm-grid">
      {list.map((p) => {
        const on = perms.includes(p);
        return (
          <label key={p} className={cn("perm-cell", on && "checked")}>
            <input type="checkbox" checked={on} onChange={() => toggle(p)} />
            <span><div className="perm-cell-label">{permLabel(p)}</div></span>
          </label>
        );
      })}
    </div>
  );
}
