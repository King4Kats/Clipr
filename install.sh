#!/bin/bash
# =============================================================================
# Clipr — Script d'installation sur le PC du client
# =============================================================================
# Ce script :
#   1. Vérifie que Docker est installé
#   2. Clone le repo (ou pull les dernières modifications)
#   3. Lance docker-compose
#   4. Télécharge le modèle Ollama par défaut
#   5. Configure l'auto-démarrage au boot
# =============================================================================

set -e

INSTALL_DIR="$HOME/clipr"
REPO_URL="https://github.com/King4Kats/Clipr.git"
BRANCH="claude/desktop-to-web-docker-uoaKU"

echo ""
echo "  🎬 Installation de Clipr Web"
echo "  =============================="
echo ""

# --- 1. Vérifier Docker ---
if ! command -v docker &> /dev/null; then
    echo "❌ Docker n'est pas installé."
    echo "   Installez Docker Desktop : https://docs.docker.com/desktop/"
    echo "   Ou sur Linux : curl -fsSL https://get.docker.com | sh"
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose n'est pas installé."
    exit 1
fi

echo "✅ Docker trouvé"

# --- 2. Cloner ou mettre à jour ---
if [ -d "$INSTALL_DIR" ]; then
    echo "📦 Mise à jour du code..."
    cd "$INSTALL_DIR"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
else
    echo "📦 Clonage du repository..."
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo "✅ Code à jour"

# --- 3. Lancer Docker Compose ---
echo "🐳 Démarrage des containers..."
docker compose up -d --build

echo "✅ Containers démarrés"

# --- 4. Attendre qu'Ollama soit prêt et télécharger le modèle ---
echo "⏳ Attente du démarrage d'Ollama..."
for i in $(seq 1 30); do
    if docker exec clipr-ollama ollama list &> /dev/null; then
        break
    fi
    sleep 2
done

echo "📥 Téléchargement du modèle IA (qwen2.5:3b)..."
docker exec clipr-ollama ollama pull qwen2.5:3b || true

echo "✅ Modèle IA prêt"

# --- 5. Auto-démarrage (systemd) ---
if command -v systemctl &> /dev/null; then
    echo "⚙️  Configuration de l'auto-démarrage..."

    COMPOSE_CMD="docker compose"
    command -v docker-compose &> /dev/null && COMPOSE_CMD="docker-compose"

    sudo tee /etc/systemd/system/clipr.service > /dev/null << UNIT
[Unit]
Description=Clipr Web App
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=$COMPOSE_CMD up -d
ExecStop=$COMPOSE_CMD down
User=$USER

[Install]
WantedBy=multi-user.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable clipr.service
    echo "✅ Auto-démarrage configuré"
fi

# --- Terminé ---
echo ""
echo "  🎉 Installation terminée !"
echo ""
echo "  Accédez à Clipr :"
echo "  → http://localhost:3000"
echo ""
echo "  Pour voir les logs :"
echo "  → docker compose logs -f clipr"
echo ""
echo "  Pour mettre à jour :"
echo "  → cd $INSTALL_DIR && git pull && docker compose up -d --build"
echo ""
