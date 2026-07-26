# Discord bot

PalPilot's Discord bot lets players power the server on and check status, and lets your admins run
moderation commands and hand out console logins — without opening the web console.

There is **no bot process to host**. Discord posts each slash command to the coordinator Cloud
Function (`POST /api/discord/interactions`), so the bot is as always-on and as cheap as the rest of
the control plane, and it works while the VM is powered off.

```
Discord ──(signed interaction)──► coordinator function ──(signed X-Coord-* headers)──► VM agent ──► Palworld REST
                                        │
                                        └── compute start/stop, users.json in GCS
```

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/palworld status` | members | online/offline, `ip:porta`, players online, uptime, in-game day, rates |
| `/palworld address` | members | just the `ip:port` to paste into "Join via IP" |
| `/palworld players` | members | who is online, with level and ping |
| `/palworld start` | members | powers the VM on (2–3 min to accept players) |
| `/paladmin announce message:` | admins | in-game broadcast |
| `/paladmin kick userid: [reason:]` | admins | kick a player |
| `/paladmin ban userid: [reason:]` / `unban userid:` | admins | ban / lift ban |
| `/paladmin save` | admins | save the world now |
| `/paladmin shutdown [seconds:] [message:]` | admins | graceful game-server shutdown with countdown |
| `/paladmin stop` | admins | force-stop the game server (no save) |
| `/paladmin poweroff` | admins | power the VM off (stops compute billing) |
| `/paladmin user-create username: [role:]` | admins | create a console user, returns a one-time password (ephemeral) |
| `/paladmin user-list` / `user-delete username:` | admins | list / delete console users |

`userid` values come from `/palworld players` (Palworld's own player ids). Admin replies that carry a
password are **ephemeral** — only the admin who ran the command sees them.

## Permissions

Discord roles map to the same permission set the console uses (`view, power, saves, mods, settings,
watchdog, commands, users`):

- a role in `discord_admin_role_ids` → **all** permissions, and is the only way to reach `/paladmin`;
- a role in `discord_user_role_ids` → `view` + `power` (empty variable = every guild member);
- anyone else → refused.

The mapped user (`discord:<username>`) is signed into the `X-Coord-*` RBAC headers exactly like a
console login, so the VM agent enforces the same per-endpoint checks. The bot has no privileged
side-channel.

Three gates protect the endpoint, all fail-closed:

1. **Ed25519 signature** over `timestamp + raw body` against `discord_public_key`. Only Discord can
   produce it. An unset key disables the route entirely (404).
2. **Guild check** — `guild_id` must equal `discord_guild_id`.
3. **Role check** — as above; `/paladmin` additionally requires the elevated flag.

The **bot token never reaches the coordinator** — it is only used locally by
`scripts/discord_register.py` to register commands.

## Setup

1. **Create the app** — <https://discord.com/developers/applications> → *New Application*. Under
   *Bot*, create the bot and copy its **token** (used once, locally). Under *General Information*,
   copy the **Public key** and the **Application ID**.
2. **Invite it** — *OAuth2 → URL generator*, scopes `bot` + `applications.commands`, no extra bot
   permissions needed (the bot only answers interactions). Open the URL, add it to your server.
3. **Collect IDs** — in Discord, *Settings → Advanced → Developer Mode*, then right-click your
   server → *Copy Server ID*, and right-click each role → *Copy Role ID*.
4. **Configure Terraform** (`terraform.tfvars`):

   ```hcl
   discord_public_key     = "abc123…"        # Public key, NOT the bot token
   discord_guild_id       = "123456789012345678"
   discord_admin_role_ids = "1111,2222"      # comma-separated role IDs
   discord_user_role_ids  = ""               # empty = any member may use /palworld
   ```

5. **Deploy the coordinator** (no VM downtime, players unaffected):

   ```powershell
   terraform apply -target=google_storage_bucket_object.coordinator_src `
                   -target=google_cloudfunctions2_function.coordinator
   terraform output discord_interactions_url
   ```

6. **Point Discord at it** — paste that URL into *General Information → Interactions Endpoint URL*
   and save. Discord immediately sends a signed PING; saving succeeds only if the signature check
   passes (wrong public key ⇒ Discord rejects the URL).
7. **Register the commands** (guild-scoped, appear instantly):

   ```powershell
   $env:DISCORD_BOT_TOKEN="…"; $env:DISCORD_APP_ID="…"; $env:DISCORD_GUILD_ID="…"
   python scripts/discord_register.py          # --list to inspect, --clear to remove
   ```

Re-run step 7 whenever `COMMAND_DEFS` in `coordinator/discord_bot.py` changes.

## Gotchas

- **3-second budget.** Discord discards an interaction that isn't answered within ~3s, so every
  command answers synchronously; `/palworld status` fans its four agent calls out in parallel with
  2.5s timeouts. There is no deferred/followup path — a Cloud Run instance has no guaranteed CPU
  after the response is flushed. A cold start on top of a slow agent can therefore show "the
  application did not respond"; running the command again works (the instance is warm).
- **Command set is one source of truth.** `COMMANDS` (dispatch) and `COMMAND_DEFS` (registration)
  live side by side in `coordinator/discord_bot.py`. Adding one without the other yields either an
  invisible command or "Unknown command".
- **`user-create` never overwrites.** It refuses an existing username (the console's own endpoint
  does allow updates); `user-delete` refuses to remove the last account holding `users`.
- **Turning the bot off** — clear `discord_public_key` and redeploy the coordinator: the endpoint
  goes back to 404 and nothing else changes.
