#!/bin/bash

set -euo pipefail

PROJECT_ID=$(curl -s \
-H "Metadata-Flavor: Google" \
http://metadata.google.internal/computeMetadata/v1/project/project-id)

BUCKET="${PROJECT_ID}-palworld-backups"

DATE=$(date +"%Y-%m-%d_%H-%M-%S")

BACKUP_FILE="/tmp/palworld-save-${DATE}.tar.gz"

SERVER_DIR="/home/steam/Steam"


echo "Stopping Palworld server..."

systemctl stop palworld


echo "Creating backup..."

tar \
-czf "${BACKUP_FILE}" \
-C "${SERVER_DIR}" \
Pal/Saved


echo "Uploading backup to gs://${BUCKET}..."

gsutil cp \
"${BACKUP_FILE}" \
"gs://${BUCKET}/"


echo "Cleaning temporary file..."

rm -f "${BACKUP_FILE}"


echo "Starting Palworld server..."

systemctl start palworld


echo "Backup completed successfully"