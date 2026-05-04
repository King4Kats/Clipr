# Compte-rendu — Outil de Transcription Linguistique
## Derniere mise a jour : 4 avril 2026

---

## Cahier des charges

### Objectif
Documenter les langues vernaculaires (patois, dialectes locaux) en transcrivant des enregistrements audio structures.

### Format des enregistrements
- Un **meneur** dit une phrase en **francais standard**
- **1 a 9 personnes** repetent cette phrase dans leur **langue vernaculaire**
- Chaque intervenant dit son **prenom nom** avant de prononcer la phrase
- Le nombre d'intervenants varie selon les phrases (certains n'interviennent pas)
- Le meneur est **toujours le premier a parler** dans le fichier
- Le meneur ne dit JAMAIS son nom, il enchaine les phrases
- Duree typique : 30min a 2h+
- Interventions de 3-5 secondes (nom ~1s + vernaculaire ~2-4s)
- Format audio : WAV (test), supporte aussi MP4, MTS, etc.

### Dialecte de test
Maraichin (dialecte d'oil, Vendee/Marais poitevin). Pas d'orthographe standardisee — l'IPA phonetique est la seule transcription fiable.

### Resultats attendus par sequence
- Le **texte francais** du meneur (transcription Whisper)
- Pour chaque intervenant :
  - **Prenom/nom** (separe de la phrase vernaculaire)
  - **Transcription IPA** de la partie vernaculaire uniquement
  - **Extrait audio** individuel
- Le tout editable manuellement dans l'interface

---

## Pipeline actuel (v2 — lang-id + Ollama)

```
AUDIO
  │
  ▼
Step 1 : FFmpeg extraction audio (si video)
  │
  ▼
Step 2 : SILENCE DETECT (silence-segment.py)
  │  FFmpeg silencedetect (seuil -35dB, 0.3s)
  │  Produit ~392 blocs de parole bruts
  │  Blocs courts (<1.5s) tagges "name", longs tagges "speech"
  │  Paires nom+vernaculaire detectees mais PAS fusionnees
  │  GPU: NON
  │
  ▼
Step 3 : DETECTION DE LANGUE (lang-classify.py)
  │  SpeechBrain lang-id-voxlingua107-ecapa
  │  Classifie chaque bloc : FR (is_french=true) ou vernaculaire
  │  Resultat typique : ~71 blocs FR, ~321 vernaculaires
  │  GPU: OUI → libere apres
  │
  ▼
Step 3.5 : VALIDATION FR (Whisper + Ollama)
  │  Whisper batch (large-v3) transcrit tous les blocs FR candidats
  │  Ollama verifie la coherence du texte :
  │    - Phrases coherentes en francais courant → FR
  │    - Charabia, noms de personnes au debut → FAUX (reclasse vernaculaire)
  │  Resultat : ~76 FR → Ollama filtre → ~76 (Ollama ne filtre pas assez)
  │
  ▼
Step 3.7 : REGLE FR CONSECUTIFS
  │  Si plusieurs blocs FR se suivent sans vernaculaire entre eux,
  │  seul le PREMIER est le meneur. Les suivants = vernaculaire mal classe.
  │  Resultat : 76 → 63 blocs FR
  │  GPU: NON
  │
  ▼
Step 4 : CONSTRUCTION SEQUENCES
  │  Chaque bloc FR valide = nouvelle sequence
  │  Blocs vernaculaires suivants = variantes
  │  Filtre : sequences avec < 1 variante supprimees
  │  Resultat : 63 sequences, ~313 variantes
  │
  ▼
Step 5 : ALLOSAURUS IPA (phonetize.py)
  │  Transcription IPA sur les blocs vernaculaires (pas les noms)
  │  GPU: OUI → libere apres
  │
  ▼
Step 6 : EXTRACTION CLIPS (FFmpeg asynchrone, lots de 5)
  │  1 clip FR + N clips variantes par sequence
  │  Asynchrone pour ne pas bloquer le serveur
  │
  ▼
Step 7 : SAVE DB + WebSocket linguistic:complete
```

### Modeles IA (sequentiels, jamais en parallele)
| Step | Modele | Taille | GPU |
|------|--------|--------|-----|
| 2 | FFmpeg silencedetect | - | Non |
| 3 | SpeechBrain lang-id-voxlingua107-ecapa | ~300MB | Oui |
| 3.5 | Whisper large-v3 (faster-whisper) | ~5GB | Oui |
| 3.5 | Ollama (qwen2.5:14b ou llama3.1) | ~9GB | Via Ollama |
| 5 | Allosaurus | ~100MB | Oui |

---

## Resultats du dernier test (4 avril 2026)

- **Fichier** : 01.10.WAV (35min, maraichin, ~9 intervenants)
- **Sequences produites** : 63
- **Bonnes phrases FR identifiees** : ~20
- **Faux positifs** : ~43 (vernaculaire classe comme FR)

### Phrases correctement identifiees
| Seq | Timing | Texte FR | Correct |
|-----|--------|----------|---------|
| 1 | 4-7s | "Elle se sert de l'entonnoir de cuisine" | ✅ |
| 3 | 53-55s | "une ecumoire" | ✅ |
| 6 | 153-156s | "Elle a mis le pote a vin sur la table" | ✅ |
| 11 | 250-252s | "Elle a une cruche en terre" | ✅ |
| 12 | 296-299s | "Il a rempli les quelles du chien" | ✅ |
| 14 | 344-347s | "Elle a des tasses en terre allant au feu" | ✅ |
| 15 | 375-378s | "Il a fait une grillee de pain pour le petit dejeuner" | ✅ |
| 18 | 524-526s | "Une casserole sur le feu" | ✅ |
| 28 | 922-924s | "Elle se sert de la louche" | ✅ |
| 30 | 972-976s | "Il vide son assiette de soupe a petits coups de cuillere" | ✅ |
| 35 | 1082-1084s | "Il a un vieux couteau" | ✅ |
| 37 | 1134-1136s | "Il se sert d'un couteau hachoir" | ✅ |
| 39 | 1178-1179s | "La lame de couteau" | ✅ |
| 43 | 1299-1300s | "Il coupe sa viande" | ✅ |
| 47 | 1479-1483s | "Il a emporte a boire au champ dans un recipient" | ✅ |
| 49 | 1605-1607s | "Elle a allume une chandelle de resine" | ✅ |
| 52 | 1657-1660s | "Elle a mis la chandelle de resine dans le chandelier" | ✅ |
| 54 | 1718-1721s | "Elle a une petite lampe a huile" | ✅ |
| 55 | 1745-1748s | "Elle a fait une meche pour la lampe a huile" | ✅ |
| 59 | 2039-2042s | "Elle a son plein panier de fruits" | ✅ |

### Exemples de faux positifs (vernaculaire classe comme FR)
| Seq | Texte | Pourquoi c'est faux |
|-----|-------|---------------------|
| 2 | "Pierre Billet se sert de l'huillette de chusine" | Nom + hallucination Whisper sur vernaculaire |
| 5 | "Pierre-Marie Duguay, a la tafriquette" | Nom + charabia |
| 7 | "Elle a mis le pichet de pain et de vin sur la table" | Whisper traduit le vernaculaire en pseudo-FR |
| 8 | "Yvette Raballin a mis le pichet ravane dessus la table" | Nom + traduction approximative du patois |
| 9 | "sur la table" | Fragment sans sens seul |
| 26 | "creuse" | Mot isole |

---

## Historique des approches testees (14 iterations)

| # | Approche | Resultat |
|---|----------|----------|
| 1 | Whisper tout + diarisation SpeechBrain 2 spk | ECHEC — Whisper hallucine, 2 spk au lieu de 10 |
| 2 | Diarisation 10 spk + texte Whisper | ECHEC — Whisper ne distingue pas FR/vernaculaire |
| 3 | Whisper cible par segment (N+M appels) | ECHEC — Trop lent, noms hallucines |
| 4 | Whisper batch + noms par 1er passage | Mieux en perf, noms approximatifs |
| 5 | Dummy segments 3s pour diarisation | ECHEC — 174 sequences au lieu de ~10 |
| 6 | Dummy segments 1s + lissage + merge | 70 sequences — insuffisant |
| 7 | Noms via Whisper tiny + coupure IPA | Noms parfois detectes, diarisation mauvaise |
| 8 | Detection par confiance Whisper (logprob) | ECHEC — Whisper confiant sur ses hallucinations |
| 9 | VAD Silero + diarisation SpeechBrain | Abandonne pour WhisperX |
| 10 | WhisperX (pyannote + Whisper) | 16-25 sequences, pyannote confond les voix |
| 11 | Silence detect pur (gap 5s) | Bonne decoupe temporelle, mauvais meneur |
| 12 | Silence detect + pyannote pour meneur | pyannote identifie le mauvais speaker comme meneur |
| 13 | Silence detect + lang-id SpeechBrain | **PERCEE** — FR/vernaculaire bien distingues |
| 14 | Lang-id + Ollama validation + regle consecutifs | 63 seq, ~20 bonnes — meilleur resultat |

---

## Problemes restants (par priorite)

### P1 : Trop de faux positifs FR (~43/63)
Le lang-id classe certains blocs vernaculaires comme FR. Whisper produit du pseudo-francais coherent sur ces blocs, et Ollama valide. La regle des consecutifs aide mais pas assez.

**Pistes non explorees :**
- Demander a Ollama de grouper les phrases similaires et garder l'originale
- Utiliser le score lang-id (pas juste FR/non-FR) : les vrais FR ont un score proche de 0, les faux ont un score plus negatif
- Approche semi-manuelle : timeline visuelle, l'utilisateur marque les blocs meneur

### P2 : UI bloquee apres le pipeline
Le `linguistic:complete` n'est pas toujours recu par l'UI. L'utilisateur doit revenir a l'accueil et ouvrir le projet manuellement.

### P3 : Separation nom/vernaculaire dans l'IPA
Le silence detect detecte les paires nom+vernaculaire (blocs courts + longs) mais l'IPA est encore sur le bloc complet. Il faut n'appliquer Allosaurus que sur le bloc "speech" et utiliser le bloc "name" pour le label speaker.

### P4 : Speakers tous "LOCUTEUR"
Pas de diarisation pour identifier qui est qui. pyannote confond les voix sur cet audio. Le renommage est manuel.

---

## Architecture technique

### Fichiers principaux
```
scripts/
  silence-segment.py      # Detection silences FFmpeg → blocs de parole
  lang-classify.py         # Classification langue (SpeechBrain lang-id)
  transcribe-batch.py      # Whisper batch (charge modele 1 fois)
  phonetize.py             # Allosaurus IPA
  whisperx-diarize.py      # WhisperX (plus utilise pour le linguistique)
  diarize.py               # Diarisation SpeechBrain (utilise pour transcription classique)

server/services/
  linguistic-pipeline.ts   # Pipeline complet
  whisper.ts               # Service Whisper (transcribe + transcribeBatch)
  diarization.ts           # Service diarisation (diarize + vadDiarize)

src/components/new/
  LinguisticTool.tsx       # Interface utilisateur

docs/
  CR_OUTIL_LINGUISTIQUE.md # Ce fichier
```

### Docker
- Container `clipr` : Node.js + Python (Whisper, SpeechBrain, Allosaurus, WhisperX)
- Container `clipr-ollama` : Ollama (LLM)
- Container `clipr-tunnel` : Cloudflare tunnel
- GPU partage sequentiellement entre les modeles
- HF_TOKEN requis pour pyannote (dans .env)

### DB : table `linguistic_transcriptions`
```sql
id TEXT PRIMARY KEY,
user_id TEXT,
task_id TEXT,
filename TEXT,
leader_speaker TEXT,
sequences TEXT (JSON),    -- [{french_text, french_audio, variants: [{speaker, ipa, audio}]}]
speakers TEXT (JSON),
duration REAL,
created_at TEXT
```

---

## Integration ALF (Atlas Linguistique de la France)

### Objectif
Enrichir la transcription linguistique avec les donnees historiques de l'ALF
de Gillieron (1902-1910) : 639 points d'enquete en France et zones limitrophes,
~1900 cartes lexicales en notation phonetique Rousselot-Gillieron.

L'outil affiche desormais **deux notations** par variante de locuteur :
- L'**IPA** moderne (genere par Allosaurus a partir de l'audio)
- L'**ALF (Rousselot-Gillieron)** historique converti depuis l'IPA OU recupere
  directement de la base ALF si le mot/concept est attestee

### Pipeline etendu

Apres l'etape 8 (transcription IPA Allosaurus) :

```
Step 8b : CONVERSION IPA -> ALF (Rousselot)
  | Module : server/services/alf-notation.ts
  | Pas de modele, pas de GPU : table de mapping deterministe
  | Voyelles avec timbre (ouvert/ferme) + longueur + nasalite
  | ~80 symboles couverts (gallo-roman complet)
  v
Step 8c : LOOKUP ALF historique (optionnel)
  | Module : server/services/alf-lookup.ts
  | DB : data/alf.db (SQLite, scrape SYMILA)
  | Si concept francais detecte ET point d'enquete saisi :
  |   recupere les attestations ALF voisines pour comparaison
  v
Step 9 : EXTRACTION CLIPS
  ...
```

### Sources de donnees

| Source | Usage | Volume |
|---|---|---|
| **SYMILA Toulouse** | Source principale (1900 cartes, 639 points, IPA + Rousselot) | ~250 Mo |
| **CartoDialect (ECLATS)** | Backup et donnees vectorisees | a la demande |
| **Atlas sonore LISN** | Attestations modernes (1999-2010, IPA + audio) | a la demande |
| **COCOON Huma-num** | Atlas regionaux (Alsace, Gascogne, Languedoc...) | a la demande |
| **Thesoc Nice** | Specialise occitan | a la demande |

### Acquisition des donnees ALF

Script : `scripts/alf-scrape.py`
- Aspire la base SYMILA (http://symila.univ-tlse2.fr/alf)
- Endpoints :
  - `/alf/lieux/{id}/show` -> 639 points (commune, dept, lat/lng, dialecte)
  - `/alf/cartesALF` -> 525+ concepts (mot FR + numero ALF)
  - `/alf/phraserealisee/ajax/leipzig2` (POST) -> 33217 phrases realisees
- Throttle 0.3s entre requetes (politesse)
- Idempotent : INSERT OR IGNORE, peut etre relance
- Volume final : ~250 Mo SQLite a `data/alf.db`

Usage :
```bash
python scripts/alf-scrape.py                   # full
python scripts/alf-scrape.py --max-phrases 100 # test rapide
python scripts/alf-scrape.py --skip-points     # reprise sans recharger les points
```

### Schema SQLite ALF

```sql
alf_points          -- 639 points d'enquete
  id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local

alf_cartes          -- 525+ concepts (mots francais)
  id, num_alf, titre, is_partial

alf_phrases_sources -- 181 phrases du questionnaire
  id, num_phrase, texte_fr

alf_realisations    -- 33217 prononciations par point
  id, phrase_source_id, point_id, ipa, proprietes, complete, validee

alf_realisation_cartes (m:n) -- liens realisation <-> cartes
  realisation_id, carte_id
```

### Module de conversion ALF <-> IPA

Fichier : `server/services/alf-notation.ts` + tests `alf-notation.test.ts`

API publique :
```typescript
rousselotToIpa(rousselot: string): string
ipaToRousselot(ipa: string): string
getMappingTable(): { consonants, vowels }
```

Limitations :
- Le systeme Rousselot a une ambiguite intrinseque sur les voyelles "neutres"
  vs "fermees" (ex: `e` neutre et `é` fermee donnent tous les deux /e/ en IPA).
  Le round-trip prefere la forme neutre dans ce cas.
- Couverture : 36 consonnes + 8 voyelles avec diacritiques (ouverture, fermeture,
  longueur, nasalite). 49 tests unitaires couvrant les cas typiques gallo-romans.

### Saisie du point d'enquete

Dans la configuration du projet (avant l'analyse), nouveau composant :
- Carte Leaflet des 639 points ALF (clusterises)
- Champ recherche commune (autocomplete sur communes francaises)
- Selection d'un point d'enquete -> stocke `alf_point_id` dans le projet

### Affichage des resultats

Pour chaque variante de locuteur, deux notations editables cote a cote :
- ALF (Rousselot) : mise en avant
- IPA (Allosaurus) : reference moderne
- Si attestation ALF historique disponible pour le concept au point local :
  affichee en troisieme ligne avec le numero du point

### Atlas moderne

Chaque enregistrement valide alimente `data/atlas_moderne.db` qui devient
notre propre atlas vivant en double notation. Schema :
```sql
modern_attestations
  id, concept_id (lien alf_cartes), point_alf_id (lien alf_points),
  locuteur, ipa, rousselot, audio_path, date_recording, validated_by_user
```

Une vue dediee `/atlas` permet de visualiser sur carte les attestations
collectees, comparees aux attestations ALF historiques au meme point.
