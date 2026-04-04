#!/usr/bin/env python3
"""
Segmentation par detection de silences.
Decoupe un fichier audio en blocs de parole bases sur les silences reels.

Approche :
1. Detecter tous les silences (seuil d'amplitude + duree minimum)
2. Les zones entre silences = blocs de parole (~2-5s chacun)
3. Identifier les "longs silences" (> seuil) = separation entre sequences
4. Grouper : [meneur] [intervenant1] [intervenant2] ... [long silence] [meneur] ...

Usage:
    python silence-segment.py <audio_path> --output <json>

Output JSON :
{
  "speech_blocks": [{"start": 0.5, "end": 2.3}, ...],
  "sequences": [
    {
      "leader": {"start": 0.5, "end": 2.3},
      "variants": [{"start": 3.1, "end": 5.8}, ...]
    }
  ]
}
"""

import argparse
import json
import sys
import subprocess
import re


def main():
    parser = argparse.ArgumentParser(description='Segmentation par silences')
    parser.add_argument('audio_path', help='Fichier audio')
    parser.add_argument('--output', required=True, help='Fichier JSON de sortie')
    parser.add_argument('--silence-thresh', type=float, default=-35, help='Seuil de silence en dB (defaut: -35)')
    parser.add_argument('--min-silence', type=float, default=0.3, help='Duree minimum de silence en secondes (defaut: 0.3)')
    parser.add_argument('--sequence-gap', type=float, default=2.0, help='Silence > ce seuil = nouvelle sequence (defaut: 2.0)')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Detection des silences...", file=sys.stderr)

    # Detecter les silences avec FFmpeg silencedetect
    cmd = [
        'ffmpeg', '-i', args.audio_path,
        '-af', f'silencedetect=noise={args.silence_thresh}dB:d={args.min_silence}',
        '-f', 'null', '-'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    # Parser la sortie silencedetect
    silence_starts = []
    silence_ends = []
    silence_durations = []

    for line in stderr.split('\n'):
        if 'silence_start' in line:
            match = re.search(r'silence_start:\s*([\d.]+)', line)
            if match:
                silence_starts.append(float(match.group(1)))
        elif 'silence_end' in line:
            match_end = re.search(r'silence_end:\s*([\d.]+)', line)
            match_dur = re.search(r'silence_duration:\s*([\d.]+)', line)
            if match_end:
                silence_ends.append(float(match_end.group(1)))
            if match_dur:
                silence_durations.append(float(match_dur.group(1)))

    # Obtenir la duree totale
    duration_match = re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', stderr)
    total_duration = 0
    if duration_match:
        h, m, s, ms = duration_match.groups()
        total_duration = int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 100

    print(f"STATUS: {len(silence_starts)} silences detectes dans {total_duration:.0f}s", file=sys.stderr)
    print("PROGRESS: 30", file=sys.stderr)

    # Construire les blocs de parole (entre les silences)
    speech_blocks = []

    # Premier bloc : du debut jusqu'au premier silence
    if silence_starts:
        if silence_starts[0] > 0.3:
            speech_blocks.append({'start': 0, 'end': round(silence_starts[0], 2)})
    else:
        # Pas de silence du tout
        speech_blocks.append({'start': 0, 'end': total_duration})

    # Blocs entre les silences
    for i in range(len(silence_ends)):
        block_start = silence_ends[i]
        block_end = silence_starts[i + 1] if i + 1 < len(silence_starts) else total_duration

        if block_end - block_start >= 0.5:  # Bloc de parole d'au moins 0.5s
            speech_blocks.append({
                'start': round(block_start, 2),
                'end': round(block_end, 2)
            })

    print(f"STATUS: {len(speech_blocks)} blocs de parole", file=sys.stderr)
    print("PROGRESS: 50", file=sys.stderr)

    # Identifier les gaps entre blocs consecutifs
    # Un gap > sequence_gap = nouvelle sequence (le meneur reparle)
    gaps = []
    for i in range(1, len(speech_blocks)):
        gap = speech_blocks[i]['start'] - speech_blocks[i-1]['end']
        gaps.append(gap)

    # Calculer le gap median entre intervenants (petits gaps)
    small_gaps = [g for g in gaps if g < args.sequence_gap]
    if small_gaps:
        median_gap = sorted(small_gaps)[len(small_gaps) // 2]
    else:
        median_gap = 0.5

    print(f"STATUS: Gap median entre intervenants: {median_gap:.2f}s", file=sys.stderr)

    # Construire les sequences
    # Le premier bloc de chaque groupe = meneur, les suivants = variantes
    sequences = []
    current_blocks = [speech_blocks[0]]  # Commence avec le premier bloc

    for i in range(1, len(speech_blocks)):
        gap = speech_blocks[i]['start'] - speech_blocks[i-1]['end']

        if gap >= args.sequence_gap:
            # Long silence = fin de sequence, debut de la suivante
            if len(current_blocks) >= 2:
                sequences.append({
                    'leader': current_blocks[0],
                    'variants': current_blocks[1:]
                })
            current_blocks = [speech_blocks[i]]
        else:
            current_blocks.append(speech_blocks[i])

    # Derniere sequence
    if len(current_blocks) >= 2:
        sequences.append({
            'leader': current_blocks[0],
            'variants': current_blocks[1:]
        })

    print(f"STATUS: {len(sequences)} sequences detectees", file=sys.stderr)
    print("PROGRESS: 80", file=sys.stderr)

    # Stats
    var_counts = [len(s['variants']) for s in sequences]
    print(f"STATUS: Variantes par sequence: min={min(var_counts) if var_counts else 0}, max={max(var_counts) if var_counts else 0}, moy={sum(var_counts)/len(var_counts):.1f}", file=sys.stderr)

    output = {
        'speech_blocks': speech_blocks,
        'sequences': sequences,
        'stats': {
            'total_duration': total_duration,
            'speech_blocks_count': len(speech_blocks),
            'sequences_count': len(sequences),
            'median_gap': round(median_gap, 3),
            'silence_threshold_db': args.silence_thresh,
            'sequence_gap_s': args.sequence_gap
        }
    }

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(json.dumps(output))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(sequences)} sequences, {len(speech_blocks)} blocs", file=sys.stderr)


if __name__ == '__main__':
    main()
