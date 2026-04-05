#!/usr/bin/env python3
"""
Classification de langue pour chaque bloc de parole.
Utilise SpeechBrain lang-id-voxlingua107-ecapa pour distinguer
le francais (meneur) du vernaculaire (intervenants).

Usage:
    python lang-classify.py <audio_path> --blocks <json> --output <json>

Input blocks JSON: [{"start": 4.3, "end": 6.5}, ...]
Output JSON: [{"start": 4.3, "end": 6.5, "lang": "fr", "score": -0.039, "is_french": true}, ...]
"""

import argparse
import json
import sys
import tempfile
import os


def main():
    parser = argparse.ArgumentParser(description='Classification de langue par bloc')
    parser.add_argument('audio_path', help='Fichier audio')
    parser.add_argument('--blocks', required=True, help='JSON des blocs de parole')
    parser.add_argument('--output', required=True, help='JSON de sortie')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    # Seuil : score FR > threshold → c'est du francais
    parser.add_argument('--fr-threshold', type=float, default=-1.0, help='Seuil score FR (defaut: -1.0)')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement modele detection de langue...", file=sys.stderr)

    import torch
    import soundfile as sf
    from speechbrain.inference.classifiers import EncoderClassifier

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    # Charger le modele de detection de langue
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/lang-id-voxlingua107-ecapa",
        savedir="/data/temp/langid_model",
        run_opts={"device": device}
    )

    print("PROGRESS: 15", file=sys.stderr)
    print("STATUS: Chargement audio...", file=sys.stderr)

    # Charger l'audio
    audio, sr = sf.read(args.audio_path, dtype='float32')
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)

    # Charger les blocs
    with open(args.blocks, 'r', encoding='utf-8') as f:
        blocks = json.load(f)

    print(f"STATUS: Classification de {len(blocks)} blocs...", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    results = []
    tmpdir = tempfile.mkdtemp()

    for i, block in enumerate(blocks):
        start_sample = int(block['start'] * sr)
        end_sample = int(block['end'] * sr)
        chunk = audio[start_sample:end_sample]

        if len(chunk) < sr * 0.3:
            # Bloc trop court pour classifier
            results.append({
                **block,
                'lang': 'unknown',
                'score': -999,
                'is_french': False
            })
            continue

        # Ecrire le chunk en WAV temporaire
        tmp_path = os.path.join(tmpdir, f"block_{i}.wav")
        sf.write(tmp_path, chunk, sr)

        try:
            out_prob, score, index, lang = classifier.classify_file(tmp_path)
            lang_str = lang[0] if isinstance(lang, list) else str(lang)
            score_val = score.item() if hasattr(score, 'item') else float(score)

            # Verifier si c'est du francais
            # Methode 1 : la langue detectee est 'fr'
            # Methode 2 : le score FR est au dessus du seuil
            is_fr = 'fr' in lang_str

            # Si la langue detectee n'est pas FR, verifier le score FR quand meme
            if not is_fr:
                # Chercher le score de la classe FR dans les probabilites
                try:
                    fr_idx = classifier.hparams.label_encoder.encode_label('fr: French')
                    fr_score = out_prob[0][fr_idx].item() if out_prob.dim() > 1 else out_prob[fr_idx].item()
                    if fr_score > args.fr_threshold:
                        is_fr = True
                        score_val = fr_score
                except:
                    pass

            results.append({
                **block,
                'lang': lang_str,
                'score': round(score_val, 3),
                'is_french': is_fr
            })
        except Exception as e:
            print(f"ERROR: Bloc {i} ({block['start']:.1f}-{block['end']:.1f}s): {e}", file=sys.stderr)
            results.append({
                **block,
                'lang': 'error',
                'score': -999,
                'is_french': False
            })

        # Nettoyer
        try:
            os.unlink(tmp_path)
        except:
            pass

        if i % 10 == 0:
            progress = 20 + int((i / len(blocks)) * 75)
            print(f"PROGRESS: {progress}", file=sys.stderr)

    # Cleanup
    try:
        os.rmdir(tmpdir)
    except:
        pass

    # Liberer GPU
    del classifier
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    # Stats
    fr_count = sum(1 for r in results if r['is_french'])
    vern_count = sum(1 for r in results if not r['is_french'])
    print(f"STATUS: {fr_count} blocs FR, {vern_count} blocs vernaculaires", file=sys.stderr)

    # Ecrire le resultat
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(json.dumps(results))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(results)} blocs classifies", file=sys.stderr)


if __name__ == '__main__':
    main()
