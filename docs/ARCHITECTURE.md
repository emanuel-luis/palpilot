# PalPilot — Architecture

PalPilot is a two-tier control plane for an on-demand Palworld dedicated server on Google Cloud: a small,
always-on **coordinator** (serverless) and a **VM-side agent** (the "panel") that runs next to the game. The
expensive VM only runs while players are online; everything else is cheap or free.

---

## 1. System components

```mermaid
flowchart TB
    subgraph Client
      B["Browser<br/>single-page console"]
    end

    subgraph GCP_Serverless["Always-on (serverless)"]
      CF["Coordinator<br/>Cloud Function (HTTP)"]
      GCS[("GCS buckets<br/>users.json · roles.json · watchdog.json<br/>panel code · backups")]
    end

    subgraph VM["Palworld VM (start/stop billing)"]
      P["Agent (panel)<br/>FastAPI :8080"]
      G["palworld.service<br/>game + REST API :8212"]
      W["idle watchdog"]
      D[("persistent data disk<br/>worlds · mods · slot configs")]
    end

    COMPUTE["Compute Engine API"]
    PLAYERS["Players"]

    B -- "HTTPS, Bearer session token" --> CF
    CF -- "start / stop / status" --> COMPUTE
    COMPUTE -- controls --> VM
    CF -- "reads/writes state" --> GCS
    CF -- "RBAC-signed proxy<br/>(HTTP over VM IP)" --> P
    P -- "localhost REST" --> G
    P -- "read/write" --> D
    W -- "polls players" --> G
    W -- "power off when empty" --> CF
    P -- "fetches code at boot" --> GCS
    PLAYERS -- "UDP 8211" --> G
```

- **Coordinator** — hosts the console, authenticates users, owns users/roles/watchdog state, starts/stops the VM,
  and proxies permission-checked requests to the agent. Scales to zero when idle.
- **Agent (panel)** — does the file-level work on the VM: edit `PalWorldSettings.ini`, manage save slots and mods,
  take/restore backups, and proxy the Palworld REST API. Reachable only through the coordinator's signed proxy.
- **Persistent data disk** — worlds, mods, and per-slot settings; survives every power cycle and VM recreate.

---

## 2. Authentication & request flow

Login is HTTP Basic once; the coordinator then issues a signed, expiring **session token** the browser carries as
a Bearer header. When proxying to the agent, the coordinator signs the acting user's identity + permissions so the
agent can enforce the same permission model — the agent never trusts a raw shared credential from the open port.

```mermaid
sequenceDiagram
    participant B as Browser
    participant C as Coordinator
    participant P as Agent (panel)
    participant G as Game REST

    B->>C: POST /api/login (user, pass)
    C->>C: verify (PBKDF2) + resolve effective perms (role/custom)
    C-->>B: session token (HMAC-signed, {user, perms, exp, ver})

    B->>C: action (Authorization: Bearer token)
    C->>C: verify token (sig + exp + ver) → re-read live perms
    alt permission ok
      C->>P: proxy + X-Coord-User/Perms/Ts/Sig (HMAC)
      P->>P: verify signature + freshness, enforce per-endpoint perm
      P->>G: (if needed) localhost REST call
      G-->>P: result
      P-->>C: result
      C-->>B: result
    else forbidden
      C-->>B: 403
    end
```

- **Session token** — `base64url(header).base64url(payload).hex(HMAC-SHA256(...))`, hand-rolled (no JWT dep),
  signed with a shared secret. A per-user `ver` counter allows "sign out everywhere" and password-change invalidation.
- **RBAC propagation** — the `X-Coord-*` headers are a *separate* signed construction; the agent verifies them and
  enforces the granular permission for each endpoint, expanding any legacy coarse permission for safety.

---

## 3. Permissions & roles

Granular, per-feature permissions; roles are named bundles you assign to users.

```mermaid
flowchart LR
    subgraph Perms["Permissions (per feature)"]
      direction LR
      p1[view]:::p
      p2[power]:::p
      p3[saves]:::p
      p4[mods]:::p
      p5[settings]:::p
      p6[watchdog]:::p
      p7[commands]:::p
      p8[users]:::p
    end

    R1[owner]:::r --> Perms
    R2[operator]:::r --> p1 & p2 & p3 & p4 & p5 & p6 & p7
    R3[moderator]:::r --> p1 & p7
    R4[viewer]:::r --> p1
    U["User<br/>role = one of the above,<br/>or custom + explicit perms"]:::u --> R1

    classDef p fill:#1a2026,stroke:#e2a03f,color:#e9eef2;
    classDef r fill:#14181c,stroke:#56b877,color:#e9eef2;
    classDef u fill:#14181c,stroke:#4aa3ff,color:#e9eef2;
```

Effective permissions resolve in one place: a user's role supplies the baseline; a `custom` role uses the user's
own permission list. The coordinator route table, the agent's per-endpoint checks, and the console's UI gating all
key off the same permission names.

---

## 4. Save slots & per-save settings

Each save slot is a world folder; the active one is selected by a pointer in `GameUserSettings.ini`. **Settings and
mods belong to the save, not the server** — each slot carries its own `PalWorldSettings.ini`, swapped into the live
config when the slot is activated.

```mermaid
flowchart TB
    subgraph Disk["Persistent data disk"]
      A["GameUserSettings.ini<br/>(active-world pointer)"]
      subgraph Worlds["SaveGames/0/"]
        W1["world A"]:::w
        W2["world B"]:::w
      end
      subgraph Cfg["slot configs"]
        C1["A.ini"]:::c
        C2["B.ini"]:::c
      end
      LIVE["PalWorldSettings.ini<br/>(live = active slot's)"]
    end

    A -->|points at| W1
    C1 -. "applied on activate" .-> LIVE
    LIVE -. "snapshot on edit" .-> C1

    classDef w fill:#1a2026,stroke:#4aa3ff,color:#e9eef2;
    classDef c fill:#1a2026,stroke:#e2a03f,color:#e9eef2;
```

**Activate a slot:** stop → back up current world → snapshot current settings to the outgoing slot → switch the
pointer → apply the target slot's settings → re-assert REST/admin keys (so the panel↔game link never breaks) →
start. Clone copies the settings with the world; delete removes them.

---

## 5. Idle lifecycle (cost control)

```mermaid
stateDiagram-v2
    [*] --> Off
    Off --> Booting: start (console / auto)
    Booting --> Running: provisioned
    Running --> Running: players online
    Running --> Empty: last player leaves
    Empty --> Running: a player joins
    Empty --> Off: empty > grace period (watchdog)
    Running --> Off: manual stop
```

The watchdog polls player count on the VM; when the server has been empty past the grace period it asks the
coordinator to power the VM off. Worlds/mods persist on the data disk for the next boot.

---

## 6. Deployment paths

Different parts ship differently — deliberately, so day-to-day changes never touch the live VM.

```mermaid
flowchart LR
    subgraph Src["Source"]
      FE["frontend/ (Vite/Vue)"]
      CO["coordinator/ (Python)"]
      PA["panel/ (Python)"]
      TF["*.tf / startup.sh"]
    end

    FE -->|build| IDX["coordinator/index.html<br/>(self-contained)"]
    IDX --> DEP1
    CO --> DEP1["Deploy coordinator<br/>(Cloud Function)"]
    PA -->|push| BKT[("panel bucket")]
    BKT -->|fetched on boot / self-update| VMB["VM agent"]
    TF -->|terraform apply<br/>maintenance window| INFRA["Infra / VM"]

    DEP1 -.->|no downtime| LIVE1["always-on"]
    VMB -.->|next boot| LIVE2["VM"]
    INFRA -.->|startup.sh ⇒ VM recreate| LIVE3["VM"]
```

- **Coordinator + console** → redeploy the Cloud Function (zero downtime). GitHub Actions does this on push.
- **Agent** → push to the panel bucket; the VM fetches it on next boot (or self-update). No live restart from CI.
- **Infra** → `terraform apply`. Editing `startup.sh` forces a VM recreate, so it's a planned, maintenance-window
  action; the persistent data disk is preserved across the recreate.

See **[`CICD.md`](CICD.md)** for the automated pipeline.
