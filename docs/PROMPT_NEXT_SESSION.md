# Prompt pour la prochaine session Claude

## Contexte
Tu travailles sur le projet Clipr (github.com/King4Kats/Clipr), une application web Docker (Node.js + Python) pour le traitement audio/video. Le projet tourne sur un serveur Windows accessible via SSH (host `temonia-pc`) avec un tunnel Cloudflare.

Le repo est dans `C:\Users\Kats\Documents\Prod\Clipr` en local et `C:\Clipr` sur le serveur.

## Ce qui marche deja
- Transcription audio/video classique (Whisper + diarisation SpeechBrain)
- Chunked upload (fichiers > 100MB via Cloudflare)
- Admin dashboard, auto-save, Ctrl+Z
- Documentation HTML complete

## Outil de transcription linguistique — En cours de developpement

### Cahier des charges
Documenter les langues vernaculaires. Un meneur dit une phrase en francais, puis 1 a 9 personnes repetent en patois. Chaque intervenant dit son prenom/nom avant de parler. Le meneur est toujours le premier a parler dans le fichier. Le dialecte de test est le maraichin (Vendee).

### Pipeline actuel
1. Silence detect (FFmpeg) → blocs de parole
2. Lang-id (SpeechBrain) → classifier FR vs vernaculaire
3. Whisper batch sur blocs FR + Ollama validation anti-hallucination
4. Construction sequences (bloc FR = nouvelle sequence)
5. Allosaurus IPA sur les variantes
6. Clips audio + save DB

### Etat actuel
Le pipeline produit 63 sequences dont ~20 sont correctes. Le probleme principal : ~43 faux positifs FR (vernaculaire que le lang-id classe comme francais, et Whisper produit du pseudo-francais coherent dessus).

### Integration ALF (Atlas Linguistique de la France) — En cours
- Module de conversion IPA <-> ALF Rousselot : `server/services/alf-notation.ts` (49 tests OK)
- Service de consultation base ALF : `server/services/alf-lookup.ts`
- Scraper SYMILA : `scripts/alf-scrape.py` (-> `data/alf.db`, ~250 Mo)
- TODO : carte + champ commune dans config projet, affichage double notation dans LinguisticTool, base atlas moderne, vue carte

### Lire le CR complet
`docs/CR_OUTIL_LINGUISTIQUE.md` contient le cahier des charges, le pipeline detaille, les 14 approches testees, les resultats du dernier test avec le tableau des bonnes phrases, les problemes restants, et la section integration ALF (sources, schema SQLite, conversion phonetique, atlas moderne).

## Problemes a resoudre (par priorite)

### P1 : Reduire les faux positifs FR
Le lang-id classe certains blocs vernaculaires comme FR. Whisper hallucine du francais coherent dessus. Ni Ollama ni la regle FR-consecutifs ne filtrent assez. Pistes :
- Score lang-id (les vrais FR ont score ~0, les faux ont score < -0.5)
- Ollama qui groupe les phrases similaires pour trouver l'originale
- Approche semi-manuelle (timeline visuelle, l'utilisateur marque les blocs meneur)

### P2 : UI bloquee apres le pipeline
Le WebSocket linguistic:complete n'est pas toujours recu. L'utilisateur doit ouvrir le projet depuis l'accueil.

### P3 : Separation nom/vernaculaire
Les blocs courts (nom) et longs (vernaculaire) sont deja tagges par le silence detect. Il faut n'appliquer l'IPA que sur le bloc "speech" et utiliser le bloc "name" pour le speaker.

### P4 : Speakers tous "LOCUTEUR"
Pas d'identification individuelle des intervenants.

## Regles
- Commiter en tant que King4Kats (king4kats@users.noreply.github.com)
- Pas de reference a Claude dans les commits
- Tester les scripts Python AVANT de commiter (verifier imports, signatures API)
- Licence GPL-3.0
- Pour rebuild Docker : desactiver les credential helpers avant (`ren docker-credential-desktop.exe docker-credential-desktop.exe.bak`)

## Fichier audio de test
Sur le bureau local : `C:\Users\Kats\Desktop\01.10.WAV` (361MB, 35min, maraichin)
Copie dans le container : `docker cp C:/Clipr/01.10.WAV clipr:/data/temp/test.WAV`
