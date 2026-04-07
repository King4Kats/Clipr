#!/usr/bin/env python3
"""
PHONETIZE.PY : Transcription phonetique IPA avec Allosaurus.

Ce script convertit des segments audio en transcription phonetique
au format IPA (International Phonetic Alphabet). Il utilise Allosaurus,
un reconnaisseur de phonemes universel qui fonctionne sur n'importe
quelle langue, y compris les patois et langues non documentees.

C'est tres utile pour les langues vernaculaires qui n'ont pas de
systeme d'ecriture standard : au lieu de transcrire en "mots", on
transcrit en sons (phonemes).

Exemple de sortie IPA : "lu kat minze" (phonemes, pas des mots)

Usage :
    python phonetize.py <audio_path> --segments <json_path> --output <json_path>

Format d'entree (segments JSON) :
    [{"id": "0", "start": 1.5, "end": 3.2}, ...]

Format de sortie (JSON) :
    [{"id": "0", "ipa": "lu kat minze"}, ...]
"""

# --- Imports standards ---
# argparse  : arguments en ligne de commande
# json      : serialisation JSON
# sys       : ecriture sur stderr (progression)
# os        : manipulation de chemins de fichiers
# tempfile  : creation de repertoires temporaires pour les fichiers WAV
import argparse
import json
import sys
import os
import tempfile


def main():
    """
    Fonction principale : charge le modele Allosaurus, puis transcrit
    phonetiquement chaque segment audio en IPA.

    Etapes :
    1. Charger le modele Allosaurus (reconnaisseur de phonemes universel)
    2. Charger l'audio complet et la liste des segments
    3. Pour chaque segment : extraire le morceau audio, le sauver en WAV temporaire,
       et le faire analyser par Allosaurus
    4. Sauvegarder les transcriptions IPA en JSON
    """

    # --- Arguments en ligne de commande ---
    parser = argparse.ArgumentParser(description='IPA phonetic transcription via Allosaurus')
    parser.add_argument('audio_path', help='Path to audio file (WAV preferred)')
    # --segments : fichier JSON contenant les segments a phonetiser
    #   Chaque segment doit avoir un "id", un "start" et un "end" (en secondes)
    parser.add_argument('--segments', required=True, help='JSON file with segments to phonetize [{id, start, end}]')
    parser.add_argument('--output', required=True, help='Output JSON path')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Loading Allosaurus model...", file=sys.stderr)

    # --- Import des librairies lourdes ---
    # torch     : framework deep learning (detection GPU)
    # soundfile : lecture de fichiers audio
    # numpy     : calculs numeriques (manipulation de tableaux audio)
    import torch
    import soundfile as sf
    import numpy as np

    # Detection automatique CPU/GPU
    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f"STATUS: Using device: {device}", file=sys.stderr)

    # --- Chargement du modele Allosaurus ---
    # Allosaurus est un modele de reconnaissance de phonemes "universel".
    # Contrairement a Whisper qui transcrit en mots d'une langue specifique,
    # Allosaurus produit des symboles IPA (phonemes) qui representent les sons
    # tels qu'ils sont prononces, independamment de la langue.
    # C'est ideal pour les langues sans ecriture standard.
    from allosaurus.app import read_recognizer
    model = read_recognizer()

    print("PROGRESS: 15", file=sys.stderr)
    print("STATUS: Loading audio...", file=sys.stderr)

    # --- Chargement de l'audio complet ---
    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')
    # Conversion stereo -> mono si necessaire
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # --- Chargement de la liste des segments a phonetiser ---
    with open(args.segments, 'r', encoding='utf-8') as f:
        segments = json.load(f)

    # Cas trivial : aucun segment a traiter
    if len(segments) == 0:
        _write_output(args.output, [])
        return

    print(f"STATUS: Phonetizing {len(segments)} segments...", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    # --- Boucle de phonetisation sur chaque segment ---
    results = []
    # Repertoire temporaire pour stocker les fichiers WAV extraits
    # (Allosaurus attend un chemin de fichier, pas un tableau numpy)
    tmpdir = tempfile.mkdtemp()

    for i, seg in enumerate(segments):
        # Extraction des metadonnees du segment
        seg_id = seg.get('id', str(i))   # Identifiant du segment
        start = seg.get('start', 0)       # Debut en secondes
        end = seg.get('end', 0)           # Fin en secondes

        # Conversion des temps en indices d'echantillons
        start_sample = int(start * sample_rate)
        end_sample = int(end * sample_rate)
        # Clipping pour eviter les debordements du tableau
        start_sample = max(0, start_sample)
        end_sample = min(len(audio_data), end_sample)

        # Si le segment est trop court (< 0.1 seconde), on ne peut pas
        # extraire de phonemes de facon fiable
        if end_sample - start_sample < int(sample_rate * 0.1):
            results.append({"id": seg_id, "ipa": ""})
            continue

        # Extraction du morceau audio et ecriture en fichier WAV temporaire
        chunk = audio_data[start_sample:end_sample]
        tmp_path = os.path.join(tmpdir, f"seg_{i}.wav")
        sf.write(tmp_path, chunk, sample_rate)

        try:
            # --- Reconnaissance des phonemes avec Allosaurus ---
            # model.recognize() prend un fichier WAV et retourne une chaine
            # de caracteres IPA (ex: "l u k a t m i n z e")
            # Les phonemes sont separes par des espaces.
            ipa = model.recognize(tmp_path)
            results.append({"id": seg_id, "ipa": ipa.strip()})
        except Exception as e:
            # En cas d'erreur, on retourne une chaine vide pour ce segment
            print(f"ERROR: Segment {seg_id} failed: {e}", file=sys.stderr)
            results.append({"id": seg_id, "ipa": ""})

        # Nettoyage du fichier temporaire apres utilisation
        try:
            os.unlink(tmp_path)
        except:
            pass

        # Calcul et affichage de la progression (de 20% a 95%)
        progress = 20 + int(((i + 1) / len(segments)) * 75)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    # --- Nettoyage du repertoire temporaire ---
    try:
        os.rmdir(tmpdir)
    except:
        pass

    # --- Liberation de la memoire GPU ---
    # Meme si Allosaurus utilise principalement le CPU, on libere
    # tout cache GPU eventuel pour les autres processus.
    del model
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    print("PROGRESS: 95", file=sys.stderr)
    print("STATUS: Finalizing...", file=sys.stderr)

    _write_output(args.output, results)


def _write_output(output_path, results):
    """
    Ecrit les resultats de phonetisation dans un fichier JSON et sur stdout.

    Parametres :
        output_path : chemin du fichier de sortie
        results     : liste de dictionnaires [{"id": "...", "ipa": "..."}, ...]
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    # Affichage sur stdout pour capture directe par le processus parent
    print(json.dumps(results))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! {len(results)} segments phonetized", file=sys.stderr)


# Point d'entree du script
if __name__ == '__main__':
    main()
