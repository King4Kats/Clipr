#!/bin/bash
# Installation Clipr — Script automatique
# Usage: bash install.sh

set -e

REPO_URL="https://github.com/King4Kats/Clipr.git"
BRANCH="${CLIPR_BRANCH:-main}"
INSTALL_DIR="${CLIPR_DIR:-$HOME/clipr}"

echo "==============================="
echo "  Installation de Clipr"
echo "==============================="
echo ""

# Verifier Docker
if ! command -v docker &> /dev/null; then
    echo "Docker n'est pas installe."
    echo "Installer Docker : https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "Docker Compose n'est pas disponible."
    exit 1
fi

echo "[1/4] Clonage du depot..."
if [ -d "$INSTALL_DIR" ]; then
    echo "  -> Mise a jour du depot existant..."
    cd "$INSTALL_DIR"
    git pull origin "$BRANCH"
else
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo "[2/4] Construction des images Docker..."
docker compose build

echo "[3/4] Demarrage des services..."
docker compose up -d

echo "[4/4] Configuration du demarrage automatique..."
if command -v systemctl &> /dev/null; then
    SERVICE_FILE="/etc/systemd/system/clipr.service"
    if [ ! -f "$SERVICE_FILE" ]; then
        sudo tee "$SERVICE_FILE" > /dev/null << UNIT
[Unit]
Description=Clipr Video Segmentation
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
UNIT
        sudo systemctl daemon-reload
        sudo systemctl enable clipr.service
        echo "  -> Service systemd configure (demarrage automatique)"
    fi
fi

echo ""
echo "==============================="
echo "  Clipr est pret !"
echo "==============================="
echo ""
echo "  Acces local : http://localhost:3000"
echo "  Logs        : docker compose logs -f clipr"
echo "  Arret       : docker compose down"
echo "  MAJ         : git pull && docker compose up -d --build"
echo ""
