#!/bin/bash

set -euo pipefail

exec > >(tee -a /var/log/startup_script.log)
exec 2>&1

export DEBIAN_FRONTEND=noninteractive

# Marker on the (ephemeral) boot disk. Heavy provisioning runs once per boot
# disk; a machine-type change / restart keeps the boot disk and skips it.
PROVISION_MARKER="/var/lib/palworld/provisioned"
mkdir -p /var/lib/palworld

# ---------------------------------------------------------------------------
# One-time provisioning (system packages)
# ---------------------------------------------------------------------------
if [ -f "$PROVISION_MARKER" ]; then
    echo "System already provisioned; skipping apt install"
else
    echo "Enabling Debian non-free repositories"
    sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources

    echo "Adding i386 architecture (required by steamcmd)"
    dpkg --add-architecture i386

    echo "Updating packages"
    apt-get update

    echo "Pre-accepting Steam license (non-interactive install)"
    echo steamcmd steam/question select "I AGREE" | debconf-set-selections
    echo steamcmd steam/license note '' | debconf-set-selections

    echo "Installing dependencies"
    apt-get install -y \
        steamcmd \
        screen \
        google-cloud-cli \
        cron \
        python3 \
        python3-venv \
        python3-pip \
        curl

    touch "$PROVISION_MARKER"
fi


echo "Creating steam user"
id steam >/dev/null 2>&1 || useradd -m -s /bin/bash steam


echo "Mounting data disk"
DISK="/dev/disk/by-id/google-palworld-data"
MOUNT="/home/steam/Steam"
mkdir -p "$MOUNT"

if ! blkid "$DISK"; then
    mkfs.ext4 -F "$DISK"
fi

grep -q "$DISK" /etc/fstab || \
    echo "$DISK $MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab

mount -a
chown -R steam:steam /home/steam


# ---------------------------------------------------------------------------
# Palworld (installed on the PERSISTENT data disk -> survives boot-disk change)
# ---------------------------------------------------------------------------
PALSERVER_SH="/home/steam/Steam/PalServer.sh"

echo "Installing/validating Palworld"
if [ -f "$PALSERVER_SH" ]; then
    echo "PalServer already present on data disk; skipping steamcmd download"
else
    # First run self-updates and can fail with "Missing configuration"; retry.
    for attempt in 1 2 3 4 5; do
        echo "steamcmd attempt ${attempt}"
        runuser -u steam -- /usr/games/steamcmd \
            +force_install_dir /home/steam/Steam \
            +login anonymous \
            +app_update 2394010 validate \
            +quit || true
        if [ -f "$PALSERVER_SH" ]; then
            echo "PalServer installed"
            break
        fi
        echo "PalServer.sh not found yet, retrying..."
        sleep 5
    done
fi


echo "Linking steamclient.so (required by PalServer)"
runuser -u steam -- mkdir -p /home/steam/.steam/sdk64
ln -sf /home/steam/Steam/linux64/steamclient.so \
    /home/steam/.steam/sdk64/steamclient.so
chown -h steam:steam /home/steam/.steam/sdk64/steamclient.so


# ---------------------------------------------------------------------------
# Panel/agent + watchdog code and config (cheap, refreshed every boot)
# ---------------------------------------------------------------------------
echo "Fetching admin panel files + config from metadata/bucket"

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
meta() { curl -s -H "Metadata-Flavor: Google" "$META/$1"; }

PANEL_DIR="/opt/palworld-panel"
mkdir -p "$PANEL_DIR"

PANEL_BUCKET="$(meta panel-bucket)"
PANEL_PORT="$(meta panel-port)"
PANEL_USER="$(meta panel-user)"
REST_API_PORT="$(meta rest-api-port)"
COORDINATOR_URL="$(meta coordinator-url)"
IDLE_POLL_SECONDS="$(meta idle-poll-seconds)"
IDLE_GRACE_SECONDS="$(meta idle-grace-seconds)"

# Secrets: panel-password / admin-password / coordinator-token.
# Phase 4 (opt-in, var.enable_secret_manager): read from Secret Manager
# instead of trusting the plaintext instance-metadata copies. Falls back
# to metadata automatically if the flag is unset/false, so this stays
# backward compatible with existing deployments.
USE_SECRET_MANAGER="$(meta use-secret-manager)"
if [ "$USE_SECRET_MANAGER" = "true" ]; then
    echo "Secret Manager enabled: fetching panel/admin/coordinator secrets"
    SECRET_PANEL_PW_ID="$(meta secret-panel-password-id)"
    SECRET_ADMIN_PW_ID="$(meta secret-admin-password-id)"
    SECRET_TOKEN_ID="$(meta secret-internal-token-id)"
    PANEL_PASSWORD="$(gcloud secrets versions access latest --secret="$SECRET_PANEL_PW_ID")"
    ADMIN_PASSWORD="$(gcloud secrets versions access latest --secret="$SECRET_ADMIN_PW_ID")"
    INTERNAL_TOKEN="$(gcloud secrets versions access latest --secret="$SECRET_TOKEN_ID")"
else
    PANEL_PASSWORD="$(meta panel-password)"
    ADMIN_PASSWORD="$(meta admin-password)"
    INTERNAL_TOKEN="$(meta coordinator-token)"
fi

INI_PATH="/home/steam/Steam/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"

# Panel/agent + watchdog live in GCS so they can be updated without recreate.
for attempt in 1 2 3 4 5 6; do
    if gsutil cp "gs://$PANEL_BUCKET/panel.py"            "$PANEL_DIR/panel.py" \
       && gsutil cp "gs://$PANEL_BUCKET/index.html"       "$PANEL_DIR/index.html" \
       && gsutil cp "gs://$PANEL_BUCKET/idle_watchdog.py" "$PANEL_DIR/idle_watchdog.py"; then
        break
    fi
    echo "panel code not in bucket yet, retry $attempt"
    sleep 10
done


echo "Enabling REST API in PalWorldSettings.ini"
ADMIN_PASSWORD="$ADMIN_PASSWORD" REST_PORT="$REST_API_PORT" INI_PATH="$INI_PATH" \
    python3 "$PANEL_DIR/panel.py" bootstrap


echo "Installing admin panel virtualenv (once)"
if [ ! -x "$PANEL_DIR/venv/bin/python" ]; then
    python3 -m venv "$PANEL_DIR/venv"
    "$PANEL_DIR/venv/bin/pip" install --upgrade pip
    "$PANEL_DIR/venv/bin/pip" install fastapi uvicorn
fi

# palworld-panel/palworld-watchdog run as the non-root "steam" user (see
# systemd units below); give it ownership of its own directory (self-update
# rewrites panel.py in place) and the venv.
chown -R steam:steam "$PANEL_DIR"


# ---------------------------------------------------------------------------
# systemd units (rewritten every boot so env/config stay fresh)
# ---------------------------------------------------------------------------
echo "Writing systemd units"

cat >/etc/systemd/system/palworld.service <<EOF
[Unit]
Description=Palworld Server
After=network.target

[Service]
User=steam
WorkingDirectory=/home/steam/Steam
ExecStart=/home/steam/Steam/PalServer.sh -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/palworld-panel.service <<EOF
[Unit]
Description=Palworld Admin Panel
After=network.target palworld.service

[Service]
# De-rooted (M8): only chown-to-self (no-op privilege-wise) and the
# systemctl calls below need elevation; those go through the narrow
# sudoers grant installed further down, not through running as root.
User=steam
WorkingDirectory=$PANEL_DIR
Environment=PANEL_PORT=$PANEL_PORT
Environment=PANEL_USER=$PANEL_USER
Environment=PANEL_PASSWORD=$PANEL_PASSWORD
Environment=ADMIN_PASSWORD=$ADMIN_PASSWORD
Environment=REST_PORT=$REST_API_PORT
Environment=INI_PATH=$INI_PATH
Environment=SERVICE_NAME=palworld
Environment=STEAM_USER=steam
Environment=INDEX_PATH=$PANEL_DIR/index.html
Environment=PANEL_BUCKET=$PANEL_BUCKET
Environment=PANEL_DIR=$PANEL_DIR
Environment=INTERNAL_TOKEN=$INTERNAL_TOKEN
ExecStart=$PANEL_DIR/venv/bin/python $PANEL_DIR/panel.py serve
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/palworld-watchdog.service <<EOF
[Unit]
Description=Palworld Idle Watchdog (auto power-off when empty)
After=network.target palworld.service

[Service]
# De-rooted (L4): the watchdog only makes outbound HTTP calls (local REST
# API + coordinator); it never needed root.
User=steam
WorkingDirectory=$PANEL_DIR
Environment=ADMIN_PASSWORD=$ADMIN_PASSWORD
Environment=REST_HOST=127.0.0.1
Environment=REST_PORT=$REST_API_PORT
Environment=COORDINATOR_URL=$COORDINATOR_URL
Environment=INTERNAL_TOKEN=$INTERNAL_TOKEN
Environment=POLL_SECONDS=${IDLE_POLL_SECONDS:-60}
Environment=IDLE_GRACE_SECONDS=${IDLE_GRACE_SECONDS:-1800}
ExecStart=/usr/bin/python3 $PANEL_DIR/idle_watchdog.py
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF


# ---------------------------------------------------------------------------
# sudoers drop-in (M8/L4): panel.py (now running as "steam") calls
# `systemctl restart/stop/start` on the game + its own units (config-apply
# restart, shutdown command, self-update restart). Grant exactly those
# commands, NOPASSWD, and nothing else -- no general root shell.
# ---------------------------------------------------------------------------
echo "Installing sudoers drop-in for steam (systemctl control only)"
cat >/etc/sudoers.d/palworld-panel <<'EOF'
Cmnd_Alias PALWORLD_CTL = \
    /usr/bin/systemctl start palworld, \
    /usr/bin/systemctl stop palworld, \
    /usr/bin/systemctl restart palworld, \
    /usr/bin/systemctl start palworld-panel, \
    /usr/bin/systemctl stop palworld-panel, \
    /usr/bin/systemctl restart palworld-panel, \
    /usr/bin/systemctl start palworld-watchdog, \
    /usr/bin/systemctl stop palworld-watchdog, \
    /usr/bin/systemctl restart palworld-watchdog

steam ALL=(root) NOPASSWD: PALWORLD_CTL
EOF
chmod 0440 /etc/sudoers.d/palworld-panel
visudo -cf /etc/sudoers.d/palworld-panel

systemctl daemon-reload
systemctl enable palworld palworld-panel palworld-watchdog
systemctl restart palworld palworld-panel palworld-watchdog


# ---------------------------------------------------------------------------
# Backup script + cron
# ---------------------------------------------------------------------------
echo "Installing backup script"

cat >/usr/local/bin/backup-palworld.sh <<'EOF'
#!/bin/bash
set -e
BUCKET=$(curl -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/project/project-id)
DATE=$(date +"%Y-%m-%d_%H-%M")
FILE="/tmp/palworld-$DATE.tar.gz"
systemctl stop palworld
tar czf $FILE -C /home/steam/Steam Pal/Saved
gsutil cp $FILE gs://$BUCKET-palworld-backups/
rm $FILE
systemctl start palworld
EOF

chmod +x /usr/local/bin/backup-palworld.sh

echo "Creating cron"
echo "0 */6 * * * root /usr/local/bin/backup-palworld.sh" \
    >/etc/cron.d/palworld-backup
systemctl restart cron


echo "Setup completed"
