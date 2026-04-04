# Compte-rendu — Outil de Transcription Linguistique

## Cahier des charges

### Objectif
Documenter les langues vernaculaires (patois, dialectes locaux) en transcrivant des enregistrements audio structurés.

### Format des enregistrements
- Un **meneur** dit une phrase en **francais standard**
- **1 a 9 personnes** repetent cette phrase dans leur **langue vernaculaire**
- Chaque intervenant dit son **prenom nom** avant de prononcer la phrase
- Le nombre d'intervenants varie selon les phrases
- Le meneur est **toujours le premier a parler** dans le fichier
- Duree typique : 30min a 2h+
- ~10 phrases par session (variable)
- 3-5 secondes par intervention (nom + vernaculaire)
- Format audio : WAV (test), supporte aussi MP4, MTS, etc.

### Dialecte de test
Maraichin (dialecte d'oil, Vendee/Marais poitevin). Pas de modele Whisper fine-tune existant. Pas d'orthographe standardisee — l'IPA phonetique est la seule transcription fiable.

### Resultats attendus
Pour chaque phrase :
- Le **texte francais** (transcription Whisper du meneur)
- Pour chaque intervenant : **transcription IPA** de la partie vernaculaire + **extrait audio** + **identification du locuteur**

### Interface
- Edition du texte francais, de l'IPA, des noms de speakers
- Lecture audio par variante
- Export JSON/CSV

---

## Pipeline actuel (fonctionnel)

```
Audio
  |
  v
WhisperX (Whisper + pyannote + alignement mot par mot)
  → 360 segments avec texte + speaker + timestamps
  → 10 speakers identifies
  |
  v
Identification meneur = premier speaker du fichier (SPEAKER_06)
  |
  v
Construction des tours de parole
  → Groupement segments contigus du meme speaker
  → 299 tours
  |
  v
Segmentation en sequences
  → Chaque tour du meneur = nouvelle sequence FR
  → Autres tours = variantes vernaculaires
  → Filtrage sequences < 2 variantes
  → 16 sequences, 260 variantes
  |
  v
Allosaurus IPA sur chaque variante
  → Transcription phonetique universelle
  |
  v
FFmpeg extraction clips audio par variante
  |
  v
Save DB + WebSocket complete
```

### Technologies
| Composant | Technologie | Role |
|-----------|-------------|------|
| Transcription | Whisper large-v3 (via WhisperX) | Transcription du francais |
| Diarisation | pyannote 3.1 (via WhisperX) | Identification des locuteurs |
| Alignement | WhisperX align | Timestamps mot par mot |
| IPA | Allosaurus | Transcription phonetique universelle |
| Audio | FFmpeg | Extraction, decoupe, conversion |
| GPU | NVIDIA CUDA 12.8 | Acceleration (pipeline sequentiel) |
| DB | SQLite | Stockage sequences + IPA |
| API | Express.js | Endpoints REST + WebSocket |

---

## Historique des approches testees

### Piste 1 : Whisper sur tout + diarisation 2 speakers
- Whisper transcrit TOUT l'audio en francais
- Diarisation SpeechBrain a 2 speakers
- **Resultat** : Whisper hallucine sur le vernaculaire ("Louis Hait", "Brugo Doni"), 2 speakers au lieu de 10, sequences geantes
- **Verdict** : ECHEC

### Piste 2 : Diarisation 10 speakers + segmentation par texte Whisper
- Diarisation forcee a 10 speakers
- Whisper sur tout, distinction FR/vernaculaire par le texte
- **Resultat** : Whisper ne distingue pas FR/vernaculaire, invente du francais pour tout
- **Verdict** : ECHEC

### Piste 3 : Whisper cible par segment (N+M appels)
- Diarisation identifie les voix
- Whisper sur chaque segment individuellement
- Extraction noms depuis les premiers mots de chaque variante
- **Resultat** : Trop lent (6s chargement x 60 appels), noms hallucines
- **Verdict** : ECHEC (perf + qualite)

### Piste 4 : Whisper batch + noms par premier passage speaker
- Nouveau script transcribe-batch.py (charge modele 1 fois)
- Noms detectes 1 fois sur le premier passage de chaque speaker
- IPA skip les 3 premieres secondes (le nom)
- **Resultat** : Plus rapide, noms approximatifs, IPA coupee arbitrairement
- **Verdict** : AMELIORATION perf, qualite moyenne

### Piste 5 : Dummy segments 3s pour diarisation
- Segments artificiels de 3s pour la diarisation SpeechBrain
- Merge tours avec gap de 3s
- **Resultat** : 174 sequences au lieu de ~10
- **Verdict** : ECHEC (segments ne correspondent pas aux vrais tours)

### Piste 6 : Dummy segments 1s + lissage labels + merge agressif
- Segments de 1s pour meilleure resolution
- Lissage par vote majoritaire (fenetre 7)
- Suppression micro-tours < 1.5s
- Merge tours contigus + merge sequences leader sans variantes
- **Resultat** : 70 sequences (~mieux mais encore trop)
- **Verdict** : AMELIORATION insuffisante

### Piste 7 : Noms via Whisper tiny + coupure IPA mesuree
- Whisper tiny (rapide) sur premier passage de chaque speaker
- Mesure duree du nom via timestamps Whisper
- IPA Allosaurus apres la duree du nom
- 2 batch Whisper : tiny pour noms + large-v3 pour FR
- **Resultat** : Noms parfois detectes, IPA meilleure
- **Verdict** : AMELIORATION, mais diarisation toujours mauvaise

### Piste 8 : Detection par la langue (confiance Whisper)
- Whisper sur tout l'audio avec avg_logprob par segment
- Classifier : confiance haute = FR, confiance basse = vernaculaire
- **Resultat** : Whisper confiant meme sur ses hallucinations (logprob > -0.3 pour tout), 0 sequences
- **Verdict** : ECHEC (Whisper est confiant dans ses hallucinations)

### Piste 9 : VAD (Silero) + diarisation SpeechBrain
- Silero VAD detecte les vrais segments de parole (silences)
- SpeechBrain embed chaque segment VAD
- Clustering spectral pour les speakers
- **Resultat** : Non teste completement (passe a WhisperX avant)
- **Verdict** : ABANDONNE pour WhisperX

### Piste 10 : WhisperX (Whisper + pyannote) ← ACTUELLE
- WhisperX fait tout en un pass : transcription + alignement + diarisation
- pyannote 3.1 pour la diarisation (SOTA)
- Premier speaker = meneur
- **Resultat** : 16 sequences, 260 variantes, 10 speakers identifies correctement
- **Verdict** : SUCCES — meilleur resultat obtenu

---

## Problemes connus

### Pipeline
1. **Le texte FR du meneur inclut parfois du vernaculaire** : Whisper hallucine sur les premieres phrases vernaculaires si elles sont trop proches du tour meneur → le FR est "pollue"
2. **Les noms des locuteurs sont perdus** : Whisper ne capte pas correctement les prenoms dits en vernaculaire, les speakers restent SPEAKER_00 a SPEAKER_09 → renommage manuel necessaire
3. **Le meneur n'est pas toujours SPEAKER_06** : pyannote numerate les speakers dans l'ordre de premiere apparition, le premier n'est pas toujours 00
4. **La sequence 9 a 36 variantes** : pyannote a fusionne plusieurs phrases du meneur en un seul "tour" → une mega-sequence au lieu de 3-4

### UI
5. **La progression reste bloquee a 0%** sur l'etape "extraction extraits audio" → le linguistic:complete n'est pas recu par l'UI
6. **Ouvrir un projet termine** ne montre pas toujours les bons resultats → probleme de chargement des donnees
7. **Pas de preview audio** pendant le traitement

### Performance
8. **Le build Docker est tres long** (~15min) a cause des dependances CUDA + whisperx + pyannote
9. **Le premier lancement telecharge les modeles** pyannote (~2GB) ce qui ajoute du temps
10. **L'IPA Allosaurus est brute** : contient le nom + le vernaculaire melanges → pas de separation automatique

---

## Resultats du dernier test (WhisperX + pyannote)

- **Fichier** : 01.10.WAV (35min, maraichin)
- **Speakers detectes** : 10 (SPEAKER_00 a SPEAKER_09)
- **Meneur identifie** : SPEAKER_06
- **Sequences** : 16
- **Variantes totales** : 260
- **IPA generee** : Oui pour toutes les variantes

### Distribution des variantes par sequence
| Seq | Variantes | FR (debut) |
|-----|-----------|------------|
| 1 | 15 | "Ouillette. Elle se sert de l'entonnoir..." |
| 2 | 12 | "Burgodonier, il y a eu ce point." |
| 3 | 13 | "Albert Averti, elle a mis le pichet..." |
| 4 | 14 | "Il a rempli l'ecuelle du chien..." |
| 5 | 5 | "La fete du gralai avec le grillepan." |
| 6 | 15 | "Burgo Doigny, elle a mis sa casserole..." |
| 7 | 10 | "Une casserole bosselee..." |
| 8 | 15 | "Burgo Doni, elle a fait une tracette..." |
| 9 | 36 | "Je vais lui donner la deux douzaines..." |
| 10 | 15 | "Burgo Doni, il se sert d'un hachoir." |
| 11 | 16 | "Il a une lame de couteau ebrechee." |
| 12 | 17 | "Pierre-Marie Duguay, les charognes..." |
| 13 | 17 | "Bourgogne, il a ete une bonne empaille..." |
| 14 | 30 | "Albert Averti a allume une chandelle..." |
| 15 | 14 | "Virgo Donnier, elle a un peu d'oeil..." |
| 16 | 16 | "Elle a son plein panier de fruits..." |

### Observations
- Les sequences 9 et 14 ont beaucoup trop de variantes (36 et 30) → pyannote a fusionne plusieurs tours du meneur
- Le texte FR est souvent pollue par des noms de locuteurs que Whisper hallucine
- Les 10 speakers sont stables (les memes reviennent dans chaque sequence)
- L'IPA est generee pour toutes les variantes mais inclut le prenom/nom

---

## Prochaines etapes

1. **Separer le nom de l'IPA** : detecter la micro-pause entre le prenom et le vernaculaire dans chaque variante, ou utiliser Whisper tiny pour capter le nom et couper l'IPA apres
2. **Ameliorer la segmentation** : empecher pyannote de fusionner plusieurs tours du meneur (sequences trop longues)
3. **Fix UI** : la progression ne se met pas a jour correctement, l'ouverture des projets est buggee
4. **Pre-telecharger les modeles** pyannote dans le Dockerfile pour eviter le long premier lancement
5. **Fine-tuner Allosaurus** sur des corrections manuelles pour ameliorer la qualite IPA
