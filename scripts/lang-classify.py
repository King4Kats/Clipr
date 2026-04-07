#!/usr/bin/env python3
"""
LANG-CLASSIFY.PY : Classification de la langue pour chaque bloc de parole.

Ce script analyse chaque bloc audio et determine s'il s'agit de francais
ou d'une langue vernaculaire (patois, creole, etc.). Il utilise le modele
SpeechBrain "lang-id-voxlingua107-ecapa" qui peut identifier 107 langues.

Cas d'usage typique : apres la segmentation par silences (silence-segment.py),
on veut savoir quels blocs correspondent au meneur (francais) et quels blocs
correspondent aux intervenants (langue vernaculaire).

Usage :
    python lang-classify.py <audio_path> --blocks <json> --output <json>

Format d'entree (blocs JSON) :
    [{"start": 4.3, "end": 6.5}, ...]

Format de sortie (JSON) :
    [{"start": 4.3, "end": 6.5, "lang": "fr", "score": -0.039, "is_french": true}, ...]
"""

# --- Imports standards ---
# argparse  : arguments en ligne de commande
# json      : serialisation JSON
# sys       : ecriture sur stderr (progression)
# tempfile  : creation de repertoires temporaires pour les fichiers WAV
# os        : manipulation de chemins de fichiers
import argparse
import json
import sys
import tempfile
import os


def main():
    """
    Fonction principale : charge le modele de detection de langue, puis
    classifie chaque bloc audio comme francais ou langue vernaculaire.
    """

    # --- Arguments en ligne de commande ---
    parser = argparse.ArgumentParser(description='Classification de langue par bloc')
    parser.add_argument('audio_path', help='Fichier audio')
    # --blocks : fichier JSON contenant la liste des blocs a classifier
    parser.add_argument('--blocks', required=True, help='JSON des blocs de parole')
    parser.add_argument('--output', required=True, help='JSON de sortie')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    # --fr-threshold : seuil de confiance pour considerer qu'un bloc est en francais.
    #   Si le score de la classe "francais" est au-dessus de ce seuil, on considere
    #   que c'est du francais meme si une autre langue a un score plus eleve.
    #   -1.0 est un seuil assez permissif (en log-probabilite).
    parser.add_argument('--fr-threshold', type=float, default=-1.0, help='Seuil score FR (defaut: -1.0)')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement modele detection de langue...", file=sys.stderr)

    # --- Import des librairies lourdes ---
    import torch
    import soundfile as sf
    # EncoderClassifier de SpeechBrain : modele de classification audio
    # (ici utilise pour la detection de langue, mais la meme classe sert
    # aussi pour la reconnaissance de locuteur dans diarize.py)
    from speechbrain.inference.classifiers import EncoderClassifier

    # Detection automatique CPU/GPU
    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    # --- Chargement du modele de detection de langue ---
    # "lang-id-voxlingua107-ecapa" est entraine sur 107 langues
    # Il utilise l'architecture ECAPA-TDNN (comme le modele de diarisation)
    # mais entraine pour classifier la langue au lieu du locuteur.
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/lang-id-voxlingua107-ecapa",
        savedir="/data/temp/langid_model",  # Cache local du modele
        run_opts={"device": device}
    )

    print("PROGRESS: 15", file=sys.stderr)
    print("STATUS: Chargement audio...", file=sys.stderr)

    # --- Chargement de l'audio complet ---
    audio, sr = sf.read(args.audio_path, dtype='float32')
    # Conversion stereo -> mono si necessaire
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)

    # --- Chargement de la liste des blocs a classifier ---
    with open(args.blocks, 'r', encoding='utf-8') as f:
        blocks = json.load(f)

    print(f"STATUS: Classification de {len(blocks)} blocs...", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    # --- Boucle de classification sur chaque bloc ---
    results = []
    # Repertoire temporaire pour stocker les fichiers WAV extraits
    # (SpeechBrain classify_file attend un chemin de fichier, pas un tableau numpy)
    tmpdir = tempfile.mkdtemp()

    for i, block in enumerate(blocks):
        # Extraction du morceau audio correspondant au bloc
        start_sample = int(block['start'] * sr)
        end_sample = int(block['end'] * sr)
        chunk = audio[start_sample:end_sample]

        # Si le bloc est trop court (< 0.3 seconde), on ne peut pas le classifier
        # de facon fiable. On le marque comme "unknown".
        if len(chunk) < sr * 0.3:
            results.append({
                **block,           # On copie tous les champs existants du bloc
                'lang': 'unknown',
                'score': -999,     # Score invalide (marqueur)
                'is_french': False
            })
            continue

        # Ecriture du morceau audio dans un fichier WAV temporaire
        # (necessaire car l'API SpeechBrain classify_file attend un chemin de fichier)
        tmp_path = os.path.join(tmpdir, f"block_{i}.wav")
        sf.write(tmp_path, chunk, sr)

        try:
            # --- Classification de la langue ---
            # classify_file retourne :
            #   out_prob : tenseur des probabilites pour chaque langue (107 classes)
            #   score    : score de confiance de la langue detectee
            #   index    : indice de la langue detectee dans le vocabulaire
            #   lang     : nom de la langue detectee (ex: "fr: French")
            out_prob, score, index, lang = classifier.classify_file(tmp_path)

            # Extraction du nom de la langue sous forme de string
            lang_str = lang[0] if isinstance(lang, list) else str(lang)
            # Conversion du score en float Python simple
            score_val = score.item() if hasattr(score, 'item') else float(score)

            # --- Verification si c'est du francais ---
            # Methode 1 : la langue detectee contient "fr" dans son nom
            is_fr = 'fr' in lang_str

            # Methode 2 (fallback) : meme si la langue detectee n'est pas FR,
            # on regarde quand meme le score de la classe "francais".
            # C'est utile car le francais d'Afrique ou des DOM-TOM peut etre
            # confondu avec d'autres langues.
            if not is_fr:
                try:
                    # Recuperer l'indice de la classe "francais" dans le vocabulaire du modele
                    fr_idx = classifier.hparams.label_encoder.encode_label('fr: French')
                    # Extraire le score de probabilite pour le francais
                    fr_score = out_prob[0][fr_idx].item() if out_prob.dim() > 1 else out_prob[fr_idx].item()
                    # Si le score FR est au-dessus du seuil, on considere que c'est du francais
                    if fr_score > args.fr_threshold:
                        is_fr = True
                        score_val = fr_score
                except:
                    pass  # En cas d'erreur, on garde la detection initiale

            results.append({
                **block,
                'lang': lang_str,
                'score': round(score_val, 3),
                'is_french': is_fr
            })
        except Exception as e:
            # En cas d'erreur sur un bloc, on continue avec les suivants
            print(f"ERROR: Bloc {i} ({block['start']:.1f}-{block['end']:.1f}s): {e}", file=sys.stderr)
            results.append({
                **block,
                'lang': 'error',
                'score': -999,
                'is_french': False
            })

        # Nettoyage du fichier temporaire apres utilisation
        try:
            os.unlink(tmp_path)
        except:
            pass

        # Affichage de la progression toutes les 10 iterations
        if i % 10 == 0:
            progress = 20 + int((i / len(blocks)) * 75)
            print(f"PROGRESS: {progress}", file=sys.stderr)

    # --- Nettoyage du repertoire temporaire ---
    try:
        os.rmdir(tmpdir)
    except:
        pass

    # --- Liberation de la memoire GPU ---
    del classifier
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    # --- Statistiques finales ---
    fr_count = sum(1 for r in results if r['is_french'])
    vern_count = sum(1 for r in results if not r['is_french'])
    print(f"STATUS: {fr_count} blocs FR, {vern_count} blocs vernaculaires", file=sys.stderr)

    # --- Ecriture du resultat ---
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(json.dumps(results))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(results)} blocs classifies", file=sys.stderr)


# Point d'entree du script
if __name__ == '__main__':
    main()
