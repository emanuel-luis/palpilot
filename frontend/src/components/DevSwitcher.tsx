import { useState } from "react";
import { knobs, isMockEnabled, resetFixtures } from "@/mocks";
import { useQueryClient } from "@tanstack/react-query";
import { session } from "@/stores/session";

export function DevSwitcher() {
  if (!isMockEnabled()) return null;
  const [, tick] = useState(0);
  const bump = () => tick((v) => v + 1);
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries(); bump(); };

  return (
    <div className="dev-switcher" role="region" aria-label="Dev mock switcher">
      <h4>Mock switcher</h4>
      <div>
        <label>VM state:{" "}
          <select value={knobs.vmForce} onChange={(e) => { knobs.vmForce = e.target.value as any; refresh(); }}>
            <option value="">(auto)</option>
            <option value="off">Offline</option>
            <option value="starting">Starting</option>
            <option value="on">Online</option>
            <option value="STOPPING">Stopping</option>
          </select>
        </label>
      </div>
      <div>
        <label>Role:{" "}
          <select value={knobs.role} onChange={(e) => { knobs.role = e.target.value as any; refresh();
            // reissue /api/session by clearing perms
            session.setPerms(knobs.role, []);
          }}>
            <option>owner</option>
            <option>operator</option>
            <option>moderator</option>
            <option>viewer</option>
          </select>
        </label>
      </div>
      <div>
        <label><input type="checkbox" checked={knobs.showPlayers} onChange={(e) => { knobs.showPlayers = e.target.checked; refresh(); }} /> Show players</label>
      </div>
      <div>
        <label><input type="checkbox" checked={knobs.next503} onChange={(e) => { knobs.next503 = e.target.checked; bump(); }} /> Next call → 503</label>
      </div>
      <div>
        <label><input type="checkbox" checked={knobs.next409} onChange={(e) => { knobs.next409 = e.target.checked; bump(); }} /> Next upload part → 409</label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button className="btn btn-sm" onClick={() => { resetFixtures(); refresh(); }}>Reset data</button>
      </div>
    </div>
  );
}
