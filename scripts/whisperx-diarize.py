#!/usr/bin/env python3
"""
WhisperX : Transcription + Diarisation + Timestamps mot par mot.
Combine Whisper (transcription) + pyannote (diarisation) en un seul pass.

Produit des segments avec texte + speaker + timestamps precis.

Usage:
    python whisperx-diarize.py <audio_path> --output <json>
        --model <whisper_model> --language <lang>
        --hf-token <token> --num-speakers <N>
"""

import argparse
import json
import sys
import os


def main():
    parser = argparse.ArgumentParser(description='WhisperX transcription + diarisation')
    parser.add_argument('audio_path', help='Fichier audio')
    parser.add_argument('--output', required=True, help='Fichier JSON de sortie')
    parser.add_argument('--model', default='large-v3', help='Modele Whisper')
    parser.add_argument('--language', default='fr', help='Code langue')
    parser.add_argument('--hf-token', default='', help='Token HuggingFace pour pyannote')
    parser.add_argument('--num-speakers', type=int, default=0, help='Nombre de speakers (0=auto)')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement WhisperX...", file=sys.stderr)

    import torch
    import whisperx

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    compute_type = 'float16' if device == 'cuda' else 'int8'
    print(f"STATUS: Device={device}, compute={compute_type}", file=sys.stderr)

    hf_token = args.hf_token or os.environ.get('HF_TOKEN', '')
    if not hf_token:
        print("ERROR: HF_TOKEN requis pour pyannote", file=sys.stderr)
        sys.exit(1)

    # ── Step 1 : Transcription Whisper ──
    print("STATUS: Chargement modele Whisper...", file=sys.stderr)
    print("PROGRESS: 5", file=sys.stderr)

    model = whisperx.load_model(args.model, device, compute_type=compute_type, language=args.language)

    print("STATUS: Transcription...", file=sys.stderr)
    print("PROGRESS: 10", file=sys.stderr)

    audio = whisperx.load_audio(args.audio_path)
    result = model.transcribe(audio, batch_size=16)

    print(f"STATUS: {len(result['segments'])} segments transcrits", file=sys.stderr)
    print("PROGRESS: 40", file=sys.stderr)

    # Liberer Whisper avant d'aligner
    del model
    torch.cuda.empty_cache()
    import gc
    gc.collect()

    # ── Step 2 : Alignement mot par mot ──
    print("STATUS: Alignement timestamps...", file=sys.stderr)

    align_model, align_metadata = whisperx.load_align_model(
        language_code=args.language, device=device
    )
    result = whisperx.align(
        result["segments"], align_model, align_metadata,
        audio, device, return_char_alignments=False
    )

    print(f"STATUS: Alignement OK", file=sys.stderr)
    print("PROGRESS: 55", file=sys.stderr)

    # Liberer le modele d'alignement
    del align_model
    torch.cuda.empty_cache()
    gc.collect()

    # ── Step 3 : Diarisation pyannote via whisperx.diarize ──
    print("STATUS: Diarisation pyannote...", file=sys.stderr)

    from whisperx.diarize import DiarizationPipeline

    diarize_model = DiarizationPipeline(
        model_name="pyannote/speaker-diarization-3.1",
        token=hf_token, device=device
    )

    diarize_kwargs = {}
    if args.num_speakers > 0:
        diarize_kwargs['min_speakers'] = args.num_speakers
        diarize_kwargs['max_speakers'] = args.num_speakers

    diarize_segments = diarize_model(audio, **diarize_kwargs)

    print("PROGRESS: 85", file=sys.stderr)

    # Assigner les speakers aux segments
    result = whisperx.assign_word_speakers(diarize_segments, result)

    # Liberer pyannote
    del diarize_model
    torch.cuda.empty_cache()
    gc.collect()

    # ── Step 4 : Formater la sortie ──
    print("STATUS: Formatage resultats...", file=sys.stderr)
    print("PROGRESS: 90", file=sys.stderr)

    output_segments = []
    for i, seg in enumerate(result.get("segments", [])):
        output_segments.append({
            "id": i,
            "start": round(seg.get("start", 0), 2),
            "end": round(seg.get("end", 0), 2),
            "text": seg.get("text", "").strip(),
            "speaker": seg.get("speaker", "UNKNOWN"),
            "words": [
                {
                    "word": w.get("word", ""),
                    "start": round(w.get("start", 0), 2),
                    "end": round(w.get("end", 0), 2),
                    "speaker": w.get("speaker", seg.get("speaker", "UNKNOWN"))
                }
                for w in seg.get("words", [])
                if "start" in w
            ]
        })

    # Identifier les speakers uniques
    speakers = list(set(s["speaker"] for s in output_segments if s["speaker"] != "UNKNOWN"))
    speakers.sort()

    output = {
        "segments": output_segments,
        "speakers": speakers,
        "language": args.language
    }

    # Ecrire le resultat
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(json.dumps(output))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(output_segments)} segments, {len(speakers)} speakers", file=sys.stderr)


if __name__ == '__main__':
    main()
