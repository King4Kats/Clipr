#!/usr/bin/env python3
"""
Transcription batch : charge le modele Whisper UNE SEULE FOIS,
puis transcrit une liste de clips audio sequentiellement.

Utilisation :
    python transcribe-batch.py --manifest <json> --model <model> --language <lang> --output <json>

Format manifest d'entree :
    [{"id": "name_speaker0", "path": "/tmp/clip1.wav"}, ...]

Format sortie :
    [{"id": "name_speaker0", "text": "Bonjour", "segments": [...]}, ...]
"""

import argparse
import json
import sys
import os


def main():
    parser = argparse.ArgumentParser(description='Transcription batch Whisper')
    parser.add_argument('--manifest', required=True, help='Chemin du fichier JSON manifest')
    parser.add_argument('--model', default='large-v3', help='Modele Whisper')
    parser.add_argument('--language', default='fr', help='Code langue')
    parser.add_argument('--output', required=True, help='Chemin du fichier JSON de sortie')
    parser.add_argument('--device', default='auto', help='Device : cpu, cuda, auto')
    parser.add_argument('--prompt', default='', help='Prompt initial pour guider la transcription')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement du modele Whisper...", file=sys.stderr)

    # Import et detection du device
    try:
        from faster_whisper import WhisperModel
        print("WHISPER_ENGINE: faster-whisper", file=sys.stderr)
    except ImportError:
        print("ERROR: faster-whisper non installe", file=sys.stderr)
        sys.exit(1)

    device = args.device
    if device == 'auto':
        try:
            import torch
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        except:
            device = 'cpu'

    compute_type = 'float16' if device == 'cuda' else 'int8'
    print(f"STATUS: Device={device}, compute={compute_type}", file=sys.stderr)

    # Charger le manifest
    with open(args.manifest, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    if len(manifest) == 0:
        _write_output(args.output, [])
        return

    # Charger le modele UNE SEULE FOIS
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    print("PROGRESS: 10", file=sys.stderr)
    print(f"STATUS: Modele charge, {len(manifest)} clips a transcrire", file=sys.stderr)

    # Options de transcription communes
    transcribe_kwargs = dict(
        language=args.language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    if args.prompt:
        transcribe_kwargs['initial_prompt'] = args.prompt

    # Transcrire chaque clip sequentiellement
    results = []
    for i, item in enumerate(manifest):
        clip_id = item['id']
        clip_path = item['path']

        if not os.path.exists(clip_path):
            print(f"ERROR: Fichier introuvable : {clip_path}", file=sys.stderr)
            results.append({"id": clip_id, "text": "", "segments": []})
            continue

        try:
            segments_gen, info = model.transcribe(clip_path, **transcribe_kwargs)
            segments_list = []
            full_text = []

            for j, seg in enumerate(segments_gen):
                seg_data = {
                    'id': j,
                    'start': round(seg.start, 2),
                    'end': round(seg.end, 2),
                    'text': seg.text.strip(),
                    'avg_logprob': round(seg.avg_logprob, 3) if hasattr(seg, 'avg_logprob') else None,
                    'no_speech_prob': round(seg.no_speech_prob, 3) if hasattr(seg, 'no_speech_prob') else None
                }
                segments_list.append(seg_data)
                full_text.append(seg.text.strip())

            results.append({
                "id": clip_id,
                "text": ' '.join(full_text),
                "segments": segments_list
            })

            # Afficher la progression pour chaque clip
            print(f"SEGMENT: {json.dumps({'id': clip_id, 'text': ' '.join(full_text)})}", file=sys.stderr)

        except Exception as e:
            print(f"ERROR: Clip {clip_id} echoue : {e}", file=sys.stderr)
            results.append({"id": clip_id, "text": "", "segments": []})

        # Progression globale
        progress = 10 + int(((i + 1) / len(manifest)) * 85)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    # Liberer la memoire GPU
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

    _write_output(args.output, results)


def _write_output(output_path, results):
    """Ecriture des resultats en JSON (fichier + stdout)."""
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(json.dumps(results))


if __name__ == '__main__':
    main()
