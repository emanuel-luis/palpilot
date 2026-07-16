#!/bin/bash

set -euo pipefail

exec > >(tee -a /var/log/startup_script.log)
exec 2>&1

export DEBIAN_FRONTEND=noninteractive

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


echo "Creating steam user"


id steam >/dev/null 2>&1 || \
useradd -m -s /bin/bash steam



echo "Mounting data disk"
DISK="/dev/disk/by-id/google-palworld-data"
MOUNT="/home/steam/Steam"

mkdir -p $MOUNT


if ! blkid $DISK; then

    mkfs.ext4 -F $DISK

fi


grep -q "$DISK" /etc/fstab || \
echo "$DISK $MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab


mount -a



chown -R steam:steam /home/steam



echo "Installing Palworld"


# steamcmd installs to /usr/games (not on runuser PATH); use full path.
# force_install_dir MUST come before login (steamcmd requirement).
# First run self-updates and can fail with "Missing configuration";
# retry until PalServer.sh exists (max 5 attempts). set -e disabled per attempt.
PALSERVER_SH="/home/steam/Steam/PalServer.sh"

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


echo "Linking steamclient.so (required by PalServer)"

runuser -u steam -- mkdir -p /home/steam/.steam/sdk64
ln -sf /home/steam/Steam/linux64/steamclient.so \
/home/steam/.steam/sdk64/steamclient.so
chown -h steam:steam /home/steam/.steam/sdk64/steamclient.so


echo "Fetching admin panel files + config from metadata"

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
meta() { curl -s -H "Metadata-Flavor: Google" "$META/$1"; }

PANEL_DIR="/opt/palworld-panel"
mkdir -p "$PANEL_DIR"

PANEL_BUCKET="$(meta panel-bucket)"
PANEL_PORT="$(meta panel-port)"
PANEL_USER="$(meta panel-user)"
PANEL_PASSWORD="$(meta panel-password)"
ADMIN_PASSWORD="$(meta admin-password)"
REST_API_PORT="$(meta rest-api-port)"

# Panel code lives in GCS so it can be updated without terraform/recreate.
# Retry in case the objects are still being uploaded on first boot.
for attempt in 1 2 3 4 5 6; do
    if gsutil cp "gs://$PANEL_BUCKET/panel.py" "$PANEL_DIR/panel.py" \
       && gsutil cp "gs://$PANEL_BUCKET/index.html" "$PANEL_DIR/index.html"; then
        break
    fi
    echo "panel code not in bucket yet, retry $attempt"
    sleep 10
done

INI_PATH="/home/steam/Steam/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"


echo "Enabling REST API in PalWorldSettings.ini"

# bootstrap uses stdlib only (no fastapi needed yet); forces AdminPassword + RESTAPIEnabled.
ADMIN_PASSWORD="$ADMIN_PASSWORD" REST_PORT="$REST_API_PORT" INI_PATH="$INI_PATH" \
python3 "$PANEL_DIR/panel.py" bootstrap


echo "Creating Palworld service"


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



systemctl daemon-reload

systemctl enable palworld

systemctl start palworld



echo "Installing admin panel (FastAPI) virtualenv"

python3 -m venv "$PANEL_DIR/venv"
"$PANEL_DIR/venv/bin/pip" install --upgrade pip
"$PANEL_DIR/venv/bin/pip" install fastapi uvicorn


echo "Creating admin panel service"

cat >/etc/systemd/system/palworld-panel.service <<EOF
[Unit]
Description=Palworld Admin Panel
After=network.target palworld.service

[Service]
User=root
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
ExecStart=$PANEL_DIR/venv/bin/python $PANEL_DIR/panel.py serve
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF


systemctl daemon-reload

systemctl enable palworld-panel

systemctl start palworld-panel



echo "Installing backup script"


cat >/usr/local/bin/backup-palworld.sh <<'EOF'

#!/bin/bash

set -e


BUCKET=$(curl -H "Metadata-Flavor: Google" \
http://metadata.google.internal/computeMetadata/v1/project/project-id)


DATE=$(date +"%Y-%m-%d_%H-%M")


FILE="/tmp/palworld-$DATE.tar.gz"


systemctl stop palworld


tar \
czf $FILE \
-C /home/steam/Steam \
Pal/Saved



gsutil cp \
$FILE \
gs://$BUCKET-palworld-backups/



rm $FILE


systemctl start palworld

EOF


chmod +x /usr/local/bin/backup-palworld.sh



echo "Creating cron"


echo "0 */6 * * * root /usr/local/bin/backup-palworld.sh" \
>/etc/cron.d/palworld-backup



systemctl restart cron



echo "Setup completed"