import { useState } from "react";
import { knobs, isMockEnabled, resetFixtures } from "@/mocks";
import { useQueryClient } from "@tanstack/react-query";
import { session } from "@/stores/session";

export function DevSwitcher() {
  if (!isMockEnabled()) return null;
  // Mock mode is fixed for the page lifetime, so hook order never changes.
  /* eslint-disable react-hooks/rules-of-hooks */
  const [, tick] = useState(0);
  const qc = useQueryClient();
  /* eslint-enable react-hooks/rules-of-hooks */
  const refresh = () => { qc.invalidateQueries(); tick((v) => v + 1); };
  return (
    <div className="dev-switcher" role="region" aria-label="Dev mock switcher">
      <h4>Mock switcher</h4>
      <div><label>VM: <select value={knobs.vmForce} onChange={(e) => { knobs.vmForce = e.target.value as any; refresh(); }}>
        <option value="">(auto)</option><option value="off">Offline</option><option value="starting">Starting</option>
        <option value="on">Online</option><option value="STOPPING">Stopping</option>
      </select></label></div>
      <div><label>Role: <select value={knobs.role} onChange={(e) => { knobs.role = e.target.value as any; session.setPerms(knobs.role, []); refresh(); }}>
        <option>owner</option><option>operator</option><option>moderator</option><option>viewer</option>
      </select></label></div>
      <div><label><input type="checkbox" checked={knobs.showPlayers} onChange={(e) => { knobs.showPlayers = e.target.checked; refresh(); }} /> Show players</label></div>
      <div><label><input type="checkbox" checked={knobs.next503} onChange={(e) => { knobs.next503 = e.target.checked; tick((v) => v + 1); }} /> Next call → 503</label></div>
      <div><label><input type="checkbox" checked={knobs.next409} onChange={(e) => { knobs.next409 = e.target.checked; tick((v) => v + 1); }} /> Next upload → 409</label></div>
      <div style={{ marginTop: 6 }}><button className="btn btn-sm" onClick={() => { resetFixtures(); refresh(); }}>Reset data</button></div>
    </div>
  );
}
