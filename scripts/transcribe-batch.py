#!/usr/bin/env python3
"""
TRANSCRIBE-BATCH.PY : Transcription par lot (batch) de plusieurs clips audio.

La difference avec transcribe.py : ici, le modele Whisper est charge UNE SEULE FOIS
puis reutilise pour transcrire tous les clips. C'est beaucoup plus efficace que de
lancer transcribe.py N fois (ou le modele serait charge/decharge a chaque fois).

Cas d'usage typique : apres la diarisation (separation des locuteurs), on a
plusieurs petits clips audio (un par tour de parole) qu'on veut transcrire.

Format du manifest d'entree (JSON) :
    [{"id": "nom_speaker0", "path": "/tmp/clip1.wav"}, ...]

Format de sortie (JSON) :
    [{"id": "nom_speaker0", "text": "Bonjour", "segments": [...]}, ...]

Usage :
    python transcribe-batch.py --manifest <json> --model <model> --language <lang> --output <json>
"""

# --- Imports standards ---
# argparse : lecture des arguments en ligne de commande
# json     : serialisation/deserialisation JSON
# sys      : ecriture sur stderr pour les messages de progression
# os       : verification de l'existence des fichiers
import argparse
import json
import sys
import os


def main():
    """
    Fonction principale : charge le modele une fois, puis transcrit chaque clip du manifest.

    Etapes :
    1. Lire les arguments et le fichier manifest
    2. Charger le modele Whisper (une seule fois)
    3. Boucler sur chaque clip et le transcrire
    4. Sauvegarder tous les resultats en JSON
    """

    # --- Configuration des arguments ---
    parser = argparse.ArgumentParser(description='Transcription batch Whisper')
    # --manifest : chemin vers le fichier JSON contenant la liste des clips a transcrire
    parser.add_argument('--manifest', required=True, help='Chemin du fichier JSON manifest')
    # --model : taille du modele Whisper (tiny, base, small, medium, large-v3, etc.)
    parser.add_argument('--model', default='large-v3', help='Modele Whisper')
    # --language : code de langue ISO (ex: "fr" pour francais)
    parser.add_argument('--language', default='fr', help='Code langue')
    # --output : chemin du fichier JSON ou ecrire les resultats
    parser.add_argument('--output', required=True, help='Chemin du fichier JSON de sortie')
    # --device : cpu, cuda (GPU NVIDIA), ou auto (detection automatique)
    parser.add_argument('--device', default='auto', help='Device : cpu, cuda, auto')
    # --prompt : texte initial pour aider Whisper a reconnaitre le vocabulaire du domaine
    parser.add_argument('--prompt', default='', help='Prompt initial pour guider la transcription')
    args = parser.parse_args()

    # Messages de progression lus par le frontend Electron
    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement du modele Whisper...", file=sys.stderr)

    # --- Import de faster-whisper ---
    # Ce script requiert obligatoirement faster-whisper (pas de fallback openai-whisper)
    # car la transcription batch necessite des performances optimales.
    try:
        from faster_whisper import WhisperModel
        print("WHISPER_ENGINE: faster-whisper", file=sys.stderr)
    except ImportError:
        print("ERROR: faster-whisper non installe", file=sys.stderr)
        sys.exit(1)

    # --- Detection automatique du device ---
    # On verifie si un GPU CUDA est disponible pour accelerer la transcription.
    device = args.device
    if device == 'auto':
        try:
            import torch
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        except:
            device = 'cpu'

    # float16 sur GPU (rapide), int8 sur CPU (economise la memoire)
    compute_type = 'float16' if device == 'cuda' else 'int8'
    print(f"STATUS: Device={device}, compute={compute_type}", file=sys.stderr)

    # --- Lecture du manifest ---
    # Le manifest est un fichier JSON contenant la liste des clips a transcrire,
    # chacun avec un identifiant ("id") et un chemin vers le fichier audio ("path").
    with open(args.manifest, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    # Si le manifest est vide, on ecrit un resultat vide et on s'arrete
    if len(manifest) == 0:
        _write_output(args.output, [])
        return

    # --- Chargement du modele UNE SEULE FOIS ---
    # C'est l'avantage principal de ce script batch : le modele est charge en memoire
    # une seule fois puis reutilise pour tous les clips. Le chargement du modele
    # prend generalement 5 a 30 secondes selon la taille.
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    print("PROGRESS: 10", file=sys.stderr)
    print(f"STATUS: Modele charge, {len(manifest)} clips a transcrire", file=sys.stderr)

    # --- Options de transcription communes a tous les clips ---
    transcribe_kwargs = dict(
        language=args.language,
        beam_size=5,              # Nombre de chemins explores (compromis precision/vitesse)
        vad_filter=True,          # Filtre les silences automatiquement
        vad_parameters=dict(min_silence_duration_ms=500),  # Silence minimum de 0.5s
    )
    # Ajout du prompt initial si fourni
    if args.prompt:
        transcribe_kwargs['initial_prompt'] = args.prompt

    # --- Boucle de transcription sur chaque clip ---
    results = []
    for i, item in enumerate(manifest):
        clip_id = item['id']      # Identifiant du clip (ex: "intro_speaker0")
        clip_path = item['path']  # Chemin vers le fichier audio du clip

        # Verification que le fichier audio existe
        if not os.path.exists(clip_path):
            print(f"ERROR: Fichier introuvable : {clip_path}", file=sys.stderr)
            # On ajoute un resultat vide pour ne pas casser l'indexation
            results.append({"id": clip_id, "text": "", "segments": []})
            continue

        try:
            # Transcription du clip avec faster-whisper
            # segments_gen : generateur qui produit les segments un par un
            # info : metadonnees sur l'audio (duree, langue detectee, etc.)
            segments_gen, info = model.transcribe(clip_path, **transcribe_kwargs)
            segments_list = []
            full_text = []  # Liste des textes de chaque segment pour reconstituer le texte complet

            # Parcours de chaque segment du clip
            for j, seg in enumerate(segments_gen):
                seg_data = {
                    'id': j,
                    'start': round(seg.start, 2),
                    'end': round(seg.end, 2),
                    'text': seg.text.strip(),
                    # Scores de confiance du modele (utiles pour le debug/filtrage)
                    'avg_logprob': round(seg.avg_logprob, 3) if hasattr(seg, 'avg_logprob') else None,
                    'no_speech_prob': round(seg.no_speech_prob, 3) if hasattr(seg, 'no_speech_prob') else None
                }
                segments_list.append(seg_data)
                full_text.append(seg.text.strip())

            # Ajout du resultat : texte complet + segments detailles
            results.append({
                "id": clip_id,
                "text": ' '.join(full_text),  # Concatenation de tous les segments
                "segments": segments_list
            })

            # Envoi du segment sur stderr pour affichage en temps reel dans le frontend
            print(f"SEGMENT: {json.dumps({'id': clip_id, 'text': ' '.join(full_text)})}", file=sys.stderr)

        except Exception as e:
            # En cas d'erreur sur un clip, on continue avec les suivants
            # (on ne veut pas que l'echec d'un clip bloque tout le lot)
            print(f"ERROR: Clip {clip_id} echoue : {e}", file=sys.stderr)
            results.append({"id": clip_id, "text": "", "segments": []})

        # Progression globale : de 10% a 95% repartie sur tous les clips
        progress = 10 + int(((i + 1) / len(manifest)) * 85)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    # --- Nettoyage de la memoire GPU ---
    # Meme logique que dans transcribe.py : on libere le modele et le cache GPU
    # pour que d'autres processus (Ollama, etc.) puissent utiliser le GPU.
    del model
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(results)} clips transcrits", file=sys.stderr)

    # Ecriture des resultats en JSON
    _write_output(args.output, results)


def _write_output(output_path, results):
    """
    Ecrit les resultats de transcription dans un fichier JSON et sur stdout.

    Parametres :
        output_path : chemin du fichier JSON a ecrire
        results     : liste de dictionnaires contenant les transcriptions

    Le JSON est ecrit a la fois dans le fichier (pour persistence) et sur stdout
    (pour capture directe par le processus parent dans l'application Electron).
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(json.dumps(results))


# Point d'entree : execute main() uniquement en execution directe
if __name__ == '__main__':
    main()
