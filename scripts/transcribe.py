#!/usr/bin/env python3
"""
TRANSCRIBE.PY : Script de transcription audio vers texte avec Whisper.

Ce script prend un fichier audio en entree et produit une transcription
au format JSON avec des segments horodates (debut, fin, texte).

Il essaie d'abord d'utiliser "faster-whisper" (4 a 8 fois plus rapide),
et si cette librairie n'est pas installee, il se rabat sur "openai-whisper"
(plus lent mais fonctionnel).

Usage en ligne de commande :
    python transcribe.py <audio_path> --model <model> --language <lang> --output <json_path>

Prerequis :
    pip install faster-whisper
"""

# --- Imports standards ---
# argparse : pour lire les arguments passes en ligne de commande (ex: --model, --language)
# json     : pour convertir les resultats en format JSON (ecriture fichier + stdout)
# sys      : pour ecrire sur stderr (messages de progression) et quitter en cas d'erreur
# os       : pour manipuler les chemins de fichiers (extension, etc.)
import argparse
import json
import sys
import os


def main():
    """
    Fonction principale du script de transcription.

    Etapes :
    1. Lire les arguments de la ligne de commande
    2. Detecter quelle librairie Whisper est disponible (faster-whisper ou openai-whisper)
    3. Charger le modele de transcription
    4. Transcrire l'audio segment par segment
    5. Sauvegarder le resultat en JSON
    """

    # --- Etape 1 : Configuration des arguments en ligne de commande ---
    # Chaque argument a une valeur par defaut pour simplifier l'utilisation
    parser = argparse.ArgumentParser(description='Transcribe audio using faster-whisper')
    parser.add_argument('audio_path', help='Path to audio file')
    # --model : taille du modele Whisper (plus gros = plus precis mais plus lent)
    parser.add_argument('--model', default='large-v3', help='Model size: tiny, base, small, medium, large-v3, large-v3-turbo')
    # --language : code de la langue a transcrire (ex: "fr" pour francais)
    parser.add_argument('--language', default='fr', help='Language code')
    # --output : chemin du fichier JSON de sortie (optionnel, sinon on utilise le meme nom que l'audio)
    parser.add_argument('--output', help='Output JSON path')
    # --device : sur quel materiel executer le modele (CPU, GPU CUDA, ou detection automatique)
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    # --prompt : texte initial pour guider Whisper (utile pour le vocabulaire specifique a un domaine)
    parser.add_argument('--prompt', default='', help='Initial prompt to guide transcription with domain vocabulary')
    args = parser.parse_args()

    # --- Etape 2 : Detection de la librairie Whisper disponible ---
    # On prefere faster-whisper car il est beaucoup plus rapide.
    # Si il n'est pas installe, on essaie openai-whisper en solution de secours.
    # Si aucun des deux n'est disponible, on arrete le script avec une erreur.
    try:
        from faster_whisper import WhisperModel
        use_faster = True
        print("WHISPER_ENGINE: faster-whisper", file=sys.stderr)
    except ImportError:
        try:
            import whisper
            use_faster = False
            print("WHISPER_ENGINE: openai-whisper (slower, install faster-whisper for 4-8x speedup)", file=sys.stderr)
        except ImportError:
            print("ERROR: No whisper library found. Install with: pip install faster-whisper", file=sys.stderr)
            sys.exit(1)

    # --- Calcul du chemin de sortie ---
    # Si l'utilisateur n'a pas specifie --output, on cree un fichier JSON
    # avec le meme nom que le fichier audio (ex: audio.wav -> audio.json)
    if args.output:
        output_path = args.output
    else:
        base = os.path.splitext(args.audio_path)[0]
        output_path = base + '.json'

    # --- Messages de progression ---
    # Ces messages sur stderr sont lus par l'application Electron (le frontend)
    # pour afficher une barre de progression a l'utilisateur.
    # Le format "PROGRESS: X" indique un pourcentage (0 a 100).
    # Le format "STATUS: ..." indique un message textuel.
    print(f"PROGRESS: 0", file=sys.stderr)
    print(f"STATUS: Loading model {args.model}...", file=sys.stderr)

    # ===================================================================
    # Branche 1 : Transcription avec faster-whisper (methode preferee)
    # ===================================================================
    if use_faster:
        # --- Detection automatique du device (CPU ou GPU) ---
        # Si l'utilisateur a choisi "auto", on verifie si un GPU CUDA est disponible.
        # CUDA = technologie NVIDIA pour les calculs sur GPU, beaucoup plus rapide.
        device = args.device
        if device == 'auto':
            try:
                import torch
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            except:
                device = 'cpu'

        # --- Choix du type de calcul ---
        # float16 : precision reduite sur GPU (rapide et suffisant pour la transcription)
        # int8 : quantification sur CPU (reduit la memoire utilisee, un peu moins precis)
        compute_type = 'float16' if device == 'cuda' else 'int8'

        print(f"STATUS: Using device: {device}, compute_type: {compute_type}", file=sys.stderr)

        # --- Chargement du modele Whisper ---
        # Le modele est telecharge automatiquement la premiere fois, puis mis en cache.
        model = WhisperModel(args.model, device=device, compute_type=compute_type)

        print(f"PROGRESS: 5", file=sys.stderr)
        print(f"STATUS: Transcribing...", file=sys.stderr)

        # --- Configuration de la transcription ---
        segments_list = []
        transcribe_kwargs = dict(
            language=args.language,
            # beam_size : nombre de "chemins" explores en parallele pour trouver la meilleure transcription.
            # Plus c'est grand, plus c'est precis mais plus c'est lent. 5 est un bon compromis.
            beam_size=5,
            # vad_filter : filtre de detection d'activite vocale (Voice Activity Detection).
            # Il saute automatiquement les zones de silence, ce qui accelere la transcription.
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        # Si un prompt initial est fourni, on l'ajoute aux parametres.
        # Le prompt aide Whisper a reconnaitre du vocabulaire specifique
        # (noms propres, termes techniques, etc.)
        if args.prompt:
            transcribe_kwargs['initial_prompt'] = args.prompt
            print(f"STATUS: Using initial prompt ({len(args.prompt)} chars)", file=sys.stderr)

        # --- Lancement de la transcription ---
        # model.transcribe() retourne un generateur de segments + des infos sur l'audio.
        # Un generateur produit les segments un par un (utile pour afficher la progression).
        segments_generator, info = model.transcribe(args.audio_path, **transcribe_kwargs)

        # Duree totale de l'audio en secondes (utilisee pour calculer la progression)
        duration = info.duration

        # --- Parcours des segments transcrits ---
        # Chaque segment contient : debut, fin, texte, et des scores de confiance.
        for i, segment in enumerate(segments_generator):
            seg_data = {
                'id': i,
                'start': round(segment.start, 2),       # Temps de debut en secondes
                'end': round(segment.end, 2),             # Temps de fin en secondes
                'text': segment.text.strip(),             # Texte transcrit (sans espaces superflus)
                # avg_logprob : probabilite moyenne en log. Plus c'est proche de 0, plus le modele est confiant.
                'avg_logprob': round(segment.avg_logprob, 3) if hasattr(segment, 'avg_logprob') else None,
                # no_speech_prob : probabilite que ce segment ne contienne pas de parole.
                # Si cette valeur est elevee (ex: > 0.6), le segment est probablement du bruit.
                'no_speech_prob': round(segment.no_speech_prob, 3) if hasattr(segment, 'no_speech_prob') else None
            }
            segments_list.append(seg_data)

            # Calcul et affichage de la progression basee sur la position dans l'audio
            if duration > 0:
                progress = min(95, int((segment.end / duration) * 95) + 5)
                print(f"PROGRESS: {progress}", file=sys.stderr)

            # Envoi du segment en temps reel pour affichage immediat dans le frontend
            # Le format "SEGMENT: {...}" est parse par l'application Electron.
            print(f"SEGMENT: {json.dumps(seg_data)}", file=sys.stderr)

    # ===================================================================
    # Branche 2 : Transcription avec openai-whisper (solution de secours)
    # ===================================================================
    else:
        # Chargement du modele openai-whisper (API differente de faster-whisper)
        model = whisper.load_model(args.model)

        print(f"PROGRESS: 5", file=sys.stderr)
        print(f"STATUS: Transcribing (using slower openai-whisper)...", file=sys.stderr)

        transcribe_kwargs = dict(
            language=args.language,
            verbose=False,  # Pas d'affichage interne de whisper
        )
        if args.prompt:
            transcribe_kwargs['initial_prompt'] = args.prompt

        # Avec openai-whisper, la transcription se fait en une seule fois
        # (pas de generateur, donc pas de progression segment par segment)
        result = model.transcribe(args.audio_path, **transcribe_kwargs)

        segments_list = []
        for i, seg in enumerate(result.get('segments', [])):
            seg_data = {
                'id': i,
                'start': round(seg['start'], 2),
                'end': round(seg['end'], 2),
                'text': seg['text'].strip()
            }
            segments_list.append(seg_data)
            print(f"SEGMENT: {json.dumps(seg_data)}", file=sys.stderr)

    # ===================================================================
    # Nettoyage memoire apres transcription
    # ===================================================================
    # On supprime le modele et on vide le cache GPU pour liberer la memoire.
    # C'est important car d'autres processus (comme Ollama pour l'analyse IA)
    # peuvent avoir besoin du GPU juste apres.
    del model
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    # gc.collect() force le ramasse-miettes Python a liberer la memoire inutilisee
    import gc
    gc.collect()

    # --- Finalisation ---
    print(f"PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! {len(segments_list)} segments", file=sys.stderr)

    # --- Ecriture du fichier JSON de sortie ---
    output_data = {
        'language': args.language,
        'segments': segments_list
    }

    # ensure_ascii=False : permet d'ecrire les caracteres accentues directement (ex: e, a, u)
    # indent=2 : formatage lisible avec indentation
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    # Affiche le chemin du fichier de sortie sur stderr (pour le frontend)
    print(f"OUTPUT: {output_path}", file=sys.stderr)

    # Affiche aussi le JSON sur stdout pour capture directe par le processus parent
    print(json.dumps(output_data))


# Point d'entree du script : execute main() uniquement si le fichier est lance directement
# (pas quand il est importe comme module par un autre script)
if __name__ == '__main__':
    main()
