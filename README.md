<p align="center">
  <img src="src/assets/Clipr.svg" width="140" alt="Clipr logo">
</p>

<h1 align="center">Clipr</h1>

<p align="center">
  <strong>Une boite a outils web pour transcrire, decouper et analyser des videos avec une IA qui tourne 100% chez vous</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker" alt="Docker">
  <img src="https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/Whisper-large--v3-FF6F00?style=flat-square" alt="Whisper">
  <img src="https://img.shields.io/badge/Ollama-LLM-000000?style=flat-square" alt="Ollama">
  <img src="https://img.shields.io/badge/SQLite-Database-003B57?style=flat-square&logo=sqlite" alt="SQLite">
</p>

---

## C'est quoi Clipr ?

Clipr est une **plateforme web auto-hebergee** qui aide a travailler sur des contenus audio et video longs : interviews, conferences, documentaires, podcasts, captations de terrain.

L'idee : au lieu d'envoyer vos fichiers a un service en ligne, **tout tourne sur votre propre machine** (ou votre serveur). Les videos ne sortent pas, les transcriptions restent privees, et le moteur d'IA (Whisper pour la voix, un LLM local pour l'analyse) fonctionne sans connexion.

C'est multi-utilisateurs, multi-projets, et concu pour qu'une equipe puisse partager et collaborer sans dependre du cloud.

---

## Les 3 outils

Clipr regroupe trois outils qui partagent la meme base (comptes, projets, partage, IA) mais qui repondent a des besoins differents.

### 1. Transcription audio/video

> Transformer la parole en texte, et explorer ce qui a ete dit.

- Transcription automatique avec **Whisper large-v3** (excellent en francais)
- **Diarisation** : identifie qui parle (locuteur 1, locuteur 2, etc.)
- **Vue NLE en 4 panneaux** : transcript synchronise, nuage de mots, frequences des termes, analyse semantique IA
- Recherche dans le transcript, clic sur un mot pour voir tous ses usages
- Traitement par lots (plusieurs fichiers a la suite)
- **Export PDF** soigne avec template propre, ou export texte brut

Cas d'usage : journalistes, chercheurs, doc makers qui veulent fouiller dans des heures de rushes.

### 2. Segmentation video

> Decouper automatiquement une video longue en extraits thematiques.

- Pipeline complet : extraction audio → transcription → analyse semantique par LLM
- Le LLM (par defaut **mistral-small:22b** via Ollama) decoupe le contenu en sequences avec **titres et timecodes**
- **Consignes personnalisables** par projet : on peut dire au LLM ce qu'on cherche
- Mode **manuel** disponible : ajout/edition des segments a la main dans une timeline
- Export des extraits en MP4

Cas d'usage : creer des clips courts a partir d'une longue interview, monter un best-of, archiver par theme.

### 3. Transcription linguistique

> Outil specialise pour l'analyse de la langue parlee, avec un focus sur les dialectes et le patrimoine oral.

- Pipeline linguistique avec nettoyage des noms propres et normalisation
- Vocabulaire pre-charge **Vendee/Bretagne** (patrimoine, patois, artisanat, musique trad)
- Export adapte aux besoins de transcription scientifique

Cas d'usage : chercheurs en linguistique, ethnologues, archivistes du patrimoine oral.

---

## Pourquoi auto-heberge ?

- **Confidentialite** : aucune donnee ne quitte votre infra
- **Pas d'abonnement** : un Docker Compose, vos propres ressources
- **Choix du modele** : vous installez le LLM que vous voulez via Ollama
- **Personnalisation** : prompts, vocabulaire, consignes adaptes a votre domaine

---

## Demarrer en 3 commandes

```bash
git clone https://github.com/King4Kats/Clipr.git
cd Clipr
docker compose up -d
```

Puis ouvrir **http://localhost:3000**, creer un compte (le premier inscrit devient admin), et c'est parti.

---

## Architecture

Trois services qui tournent ensemble dans Docker Compose. Pensez-les comme trois conteneurs qui parlent entre eux sur un reseau prive :

```
+-------------------------------------------------------------+
|                      docker-compose                          |
|                                                              |
|  +---------------------+  +--------------+  +------------+  |
|  |       clipr          |  |    ollama     |  |   caddy    |  |
|  |                      |  |              |  |            |  |
|  |  Node.js (Express)   |  |  LLM local   |  |  Reverse   |  |
|  |  SQLite (donnees)    |  |  GPU         |  |  Proxy     |  |
|  |  FFmpeg              |  |              |  |  HTTPS     |  |
|  |  Python/Whisper      |  |              |  |            |  |
|  |  JWT Auth            |  |              |  |            |  |
|  |  WebSocket           |  |  :11434      |  |  :443      |  |
|  |  :3000               |  |              |  |  :80       |  |
|  +---------------------+  +--------------+  +------------+  |
|                                                              |
+-------------------------------------------------------------+
```

**En clair :**

| Service | Ce qu'il fait | Analogie |
|---------|--------------|----------|
| **clipr** | C'est l'application : le site web, l'API, la base de donnees, et le code qui appelle Whisper et FFmpeg. | Le cerveau et le visage de l'app. |
| **ollama** | Un serveur a part qui fait tourner le LLM (le modele de langage qui analyse le texte). On lui envoie une requete HTTP, il repond. | Le specialiste qu'on consulte. |
| **caddy** | Un reverse proxy : il recoit les requetes du navigateur en HTTPS et les transmet a Clipr. Il gere aussi le certificat SSL automatiquement. | Le portier qui filtre et redirige. |

Pourquoi separer **ollama** de **clipr** ? Parce que le LLM consomme beaucoup de RAM/GPU et qu'on veut pouvoir le redemarrer ou le remplacer sans toucher a l'app. Et parce qu'Ollama existe deja comme image Docker prete a l'emploi.

---

## Prerequis

- **Docker** >= 20.10 et **Docker Compose** >= 2.0
- Une machine avec au moins **16 Go de RAM** (le LLM en consomme beaucoup)
- **GPU recommande** mais pas obligatoire :
  - NVIDIA (CUDA) : top, tout va vite
  - AMD (ROCm) : Ollama fonctionne, Whisper tournera en CPU
  - CPU seul : ca marche, mais c'est lent (compter ~1x temps reel pour Whisper)

### Espace disque

| Quoi | Combien |
|------|---------|
| Image Docker Clipr | ~2 GB |
| Modele Whisper large-v3 | ~3 GB (telecharge au premier usage) |
| Modele mistral-small:22b | ~14 GB |
| Vos projets | depend des videos |

---

## Configuration

### Variables d'environnement principales

| Variable | Defaut | A quoi ca sert |
|----------|--------|----------------|
| `PORT` | `3000` | Port d'ecoute du serveur web |
| `DATA_DIR` | `/data` | Ou sont stockes la base SQLite, les uploads et les exports |
| `JWT_SECRET` | Auto-genere | La cle secrete qui signe les tokens de connexion. **A definir en prod** sinon les sessions sautent a chaque redemarrage. |
| `CORS_ORIGINS` | `*` | Quels domaines peuvent appeler l'API. En prod, mettre votre domaine. |
| `OLLAMA_HOST` | `ollama` | Le hostname du conteneur Ollama (laisser tel quel sauf cas particulier) |
| `OLLAMA_PORT` | `11434` | Port d'Ollama (idem) |

### Pour la prod

```yaml
# docker-compose.yml
services:
  clipr:
    environment:
      - JWT_SECRET=une-cle-aleatoire-tres-longue-genre-32-caracteres
      - CORS_ORIGINS=https://clipr.mon-domaine.fr
```

### HTTPS avec votre domaine

Editez `caddy/Caddyfile` :

```
clipr.mon-domaine.fr {
    reverse_proxy clipr:3000
}
```

Caddy se debrouille tout seul pour obtenir un certificat Let's Encrypt. Pas besoin de toucher a OpenSSL.

---

## Administration

L'admin a une icone bouclier dans le header. Le dashboard a 4 onglets :

- **Vue d'ensemble** : nombre d'utilisateurs, projets, espace disque, statut IA
- **Projets** : tous les projets de tout le monde (proprietaire, type, statut, segments)
- **Utilisateurs** : tous les comptes
- **Logs** : 200 dernieres lignes du serveur, en couleur (rouge = erreur, orange = warning)

---

## API Reference

Toutes les routes (sauf `register`/`login`) demandent un header `Authorization: Bearer <token>`.

### Authentification

| Methode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | `/api/auth/register` | Non | Inscription (limite : 10 essais / 15min) |
| POST | `/api/auth/login` | Non | Connexion (limite : 10 essais / 15min) |
| GET | `/api/auth/me` | JWT | Profil de l'utilisateur courant |

### Projets

| Methode | Route | Description |
|---------|-------|-------------|
| GET | `/api/project/history` | Liste des projets (max 12) |
| POST | `/api/project/create` | Creer `{name, type}` |
| POST | `/api/project/save` | Sauvegarder `{id, ...data}` |
| POST | `/api/project/autosave` | Auto-sauvegarde |
| GET | `/api/project/load/:id` | Charger un projet |
| PATCH | `/api/project/:id/rename` | Renommer `{name}` |
| DELETE | `/api/project/:id` | Supprimer (soft delete) |
| PATCH | `/api/project/:id/status` | Changer le statut |
| POST | `/api/project/:id/analyze` | Lancer l'analyse IA en arriere-plan |

### Partage

| Methode | Route | Description |
|---------|-------|-------------|
| POST | `/api/project/:id/share` | Partager `{username, role}` |
| DELETE | `/api/project/:id/share/:userId` | Retirer un partage |
| GET | `/api/project/:id/shares` | Lister les partages |
| GET | `/api/project/shared` | Projets partages avec moi |
| GET | `/api/users/search?q=` | Recherche d'utilisateurs |

### IA

| Methode | Route | Description |
|---------|-------|-------------|
| GET | `/api/ai/status` | Statut du verrou IA |
| GET | `/api/ollama/check` | Ollama est-il actif ? |
| GET | `/api/ollama/models` | Lister les modeles installes |
| POST | `/api/ollama/pull` | Telecharger un modele |

### Fichiers et exports

| Methode | Route | Description |
|---------|-------|-------------|
| POST | `/api/upload` | Upload videos (max 5 GB) |
| GET | `/api/files/:filename` | Streamer un fichier |
| POST | `/api/export/segment` | Exporter un segment video |
| POST | `/api/export/text` | Exporter du texte |
| GET | `/api/export/download/:filename` | Telecharger un export |

### Admin (role admin uniquement)

| Methode | Route | Description |
|---------|-------|-------------|
| GET | `/api/admin/users` | Tous les utilisateurs |
| GET | `/api/admin/projects` | Tous les projets |
| GET | `/api/admin/system` | Sante systeme |
| GET | `/api/admin/logs?lines=N` | Logs serveur |
| POST | `/api/update` | Declencher une mise a jour |

### WebSocket

Connexion : `ws://host/ws`. Le client s'authentifie puis souscrit a un projet pour recevoir les events de progression en temps reel.

```json
// Client -> Serveur
{"type": "auth", "token": "jwt-token"}
{"type": "subscribe", "projectId": "uuid"}
{"type": "unsubscribe"}

// Serveur -> Client
{"type": "progress", "projectId": "uuid", "step": "transcribing", "progress": 45, "message": "..."}
{"type": "transcript:segment", "projectId": "uuid", "id": "0", "start": 1.2, "end": 3.5, "text": "..."}
{"type": "analysis:complete", "projectId": "uuid", "segments": [...], "transcript": [...]}
{"type": "analysis:error", "projectId": "uuid", "message": "..."}
```

---

## Securite

Ce qui est en place :

- **Auth JWT** sur toutes les routes sensibles
- **Rate limiting** sur login/register (10 essais / 15min)
- **Bcrypt** pour les mots de passe (10 rounds)
- **Path traversal** : tous les endpoints fichiers valident `resolve()` + `startsWith()`
- **IDOR** : verification de propriete sur chaque operation projet
- **Validation des uploads** : MIME video/audio uniquement, noms assainis
- **WebSocket authentifie** : token JWT requis avant souscription
- **Soft delete** : un projet supprime n'est pas efface physiquement
- **CORS configurable**

Pour la prod : definir un `JWT_SECRET` long et aleatoire, configurer `CORS_ORIGINS`, activer HTTPS via Caddy, sauvegarder regulierement le volume `clipr-data`.

---

## Developpement

### Structure du projet

```
Clipr/
  server/                    # Backend Express (l'API)
    index.ts                 # Point d'entree, routes, WebSocket
    middleware/auth.ts       # JWT (requireAuth, requireAdmin)
    services/
      database.ts            # SQLite : schema + migrations
      auth.ts                # Inscription, connexion, JWT
      project-history.ts     # CRUD projets
      sharing.ts             # Partage de projets
      ai-lock.ts             # Verrou IA (un user a la fois)
      whisper.ts             # Transcription (lance Python)
      ollama.ts              # Appel HTTP a Ollama
      ffmpeg.ts              # Operations video
  src/                       # Frontend React (le site)
    api.ts                   # Client HTTP/WebSocket avec auth
    routes/                  # Pages React Router
      HomePage.tsx           # Accueil + liste projets
      TranscriptionPage.tsx  # Outil 1
      SegmentationNewPage.tsx# Outil 2
      LinguisticPage.tsx     # Outil 3
      AdminPage.tsx          # Dashboard admin
    store/
      useStore.ts            # Etat projet actif (Zustand)
      useAuthStore.ts        # Etat auth (token, user)
    components/new/          # Composants des outils
      TranscriptionTool.tsx  # Vue 4 panneaux
      LinguisticTool.tsx
      EditorLayout.tsx       # Editeur NLE (segmentation)
      VideoPreview.tsx
      Timeline.tsx
      ...
  scripts/transcribe.py      # Script Python qui appelle faster-whisper
  docs/index.html            # Doc utilisateur
```

### Lancer en dev

```bash
npm install
npm run dev          # Vite (client) + tsx watch (serveur), tout en parallele
```

Vite recharge le front a chaque changement. tsx redemarre le serveur a chaque modif TypeScript.

### Build prod

```bash
npm run build        # Compile front (Vite) + serveur (tsc)
npm start            # Lance le serveur compile
```

### Base de donnees

SQLite, fichier unique dans `DATA_DIR/clipr.db`. Pourquoi SQLite ? Parce que c'est un fichier, zero config, zero serveur DB a maintenir, et largement suffisant pour quelques dizaines d'utilisateurs.

| Table | Contenu |
|-------|---------|
| `users` | id, username, email, password_hash, role |
| `projects` | id, user_id, name, type, status, data (JSON), timestamps |
| `project_shares` | project_id, user_id, role |
| `ai_locks` | user_id, project_id, expires_at |

### Stack

| Couche | Techno | Pourquoi |
|--------|--------|----------|
| Frontend | React 18 + TypeScript | Standard, ecosysteme riche |
| State | Zustand | Plus simple que Redux pour ce qu'on fait |
| Style | Tailwind CSS + Radix UI | Rapide a styler, accessible par defaut |
| Animations | Framer Motion | Transitions fluides sans douleur |
| Backend | Express + TypeScript | Simple, eprouve, bien type |
| DB | better-sqlite3 | Synchrone, rapide, parfait pour SQLite |
| Auth | jsonwebtoken + bcrypt | Standard de l'industrie |
| Video | fluent-ffmpeg | Wrapper Node sympa pour FFmpeg |
| Transcription | faster-whisper (Python) | Plus rapide que whisper.cpp pour large-v3 |
| LLM | Ollama HTTP | API simple, gere les modeles tout seul |
| Temps reel | ws (WebSocket) | Push de progression au front |

---

## Commandes Docker utiles

| Commande | Quoi |
|----------|------|
| `docker compose up -d` | Demarrer tous les services en arriere-plan |
| `docker compose down` | Tout arreter |
| `docker compose logs -f clipr` | Suivre les logs en temps reel |
| `docker compose restart clipr` | Redemarrer juste l'app |
| `docker compose build --no-cache` | Reconstruire from scratch |
| `docker compose exec clipr sh` | Ouvrir un shell dans le conteneur |

---

## Licence

Ce projet est distribue sous licence **GPL-3.0**. Voir [LICENSE](LICENSE).

---

<p align="center">
  <sub>Fait par <a href="https://github.com/King4Kats">King4Kats</a></sub>
</p>
