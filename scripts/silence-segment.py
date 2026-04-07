#!/usr/bin/env python3
"""
SILENCE-SEGMENT.PY : Segmentation audio par detection de silences.

Ce script decoupe un fichier audio en blocs de parole en se basant sur les
silences detectes par FFmpeg. Il est specialement concu pour des enregistrements
de type "enquete linguistique" ou un meneur (qui parle en francais) est suivi
de plusieurs intervenants (qui parlent en langue vernaculaire/patois).

Approche en 4 etapes :
1. Detecter tous les silences avec FFmpeg (seuil d'amplitude + duree minimum)
2. Les zones entre silences = blocs de parole (~2-5 secondes chacun)
3. Identifier les "longs silences" (> seuil) = separation entre sequences
4. Grouper les blocs en sequences : [meneur] [intervenant1] [intervenant2] ... [long silence] [meneur] ...

Usage :
    python silence-segment.py <audio_path> --output <json>

Format de sortie JSON :
{
  "speech_blocks": [{"start": 0.5, "end": 2.3, "type": "name", "pair_id": 0}, ...],
  "sequences": [
    {
      "leader": {"start": 0.5, "end": 2.3},
      "variants": [{"start": 3.1, "end": 5.8}, ...]
    }
  ],
  "stats": { ... }
}
"""

# --- Imports standards ---
# argparse    : arguments en ligne de commande
# json        : serialisation JSON
# sys         : ecriture sur stderr (messages de progression)
# subprocess  : execution de commandes externes (FFmpeg)
# re          : expressions regulieres pour parser la sortie de FFmpeg
import argparse
import json
import sys
import subprocess
import re


def main():
    """
    Fonction principale : detecte les silences avec FFmpeg, construit les blocs
    de parole, identifie les paires nom/discours, et regroupe en sequences.
    """

    # --- Arguments en ligne de commande ---
    parser = argparse.ArgumentParser(description='Segmentation par silences')
    parser.add_argument('audio_path', help='Fichier audio')
    parser.add_argument('--output', required=True, help='Fichier JSON de sortie')
    # --silence-thresh : seuil en decibels sous lequel on considere que c'est du silence
    #   -35 dB est un bon compromis (assez sensible sans detecter le bruit de fond)
    parser.add_argument('--silence-thresh', type=float, default=-35, help='Seuil de silence en dB (defaut: -35)')
    # --min-silence : duree minimum d'un silence pour qu'il soit detecte (en secondes)
    #   0.3s evite de couper au milieu d'une respiration
    parser.add_argument('--min-silence', type=float, default=0.3, help='Duree minimum de silence en secondes (defaut: 0.3)')
    # --sequence-gap : si un silence depasse cette duree, c'est une nouvelle sequence
    #   2.0s correspond a la pause entre deux "tours" du meneur
    parser.add_argument('--sequence-gap', type=float, default=2.0, help='Silence > ce seuil = nouvelle sequence (defaut: 2.0)')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Detection des silences...", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 1 : Detection des silences avec FFmpeg
    # ══════════════════════════════════════════════════════════════
    # On utilise le filtre "silencedetect" de FFmpeg qui analyse l'amplitude
    # de l'audio et detecte les zones ou le volume est en dessous du seuil
    # pendant au moins la duree minimale.
    #
    # La commande FFmpeg ecrit les resultats sur stderr (pas stdout).
    # On utilise "-f null -" pour ne pas produire de fichier de sortie.
    cmd = [
        'ffmpeg', '-i', args.audio_path,
        '-af', f'silencedetect=noise={args.silence_thresh}dB:d={args.min_silence}',
        '-f', 'null', '-'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    # --- Parsing de la sortie FFmpeg ---
    # FFmpeg produit des lignes comme :
    #   [silencedetect @ 0x...] silence_start: 1.234
    #   [silencedetect @ 0x...] silence_end: 2.567 | silence_duration: 1.333
    # On extrait ces valeurs avec des expressions regulieres.
    silence_starts = []      # Timestamps de debut de chaque silence
    silence_ends = []        # Timestamps de fin de chaque silence
    silence_durations = []   # Durees de chaque silence

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

    # --- Extraction de la duree totale de l'audio ---
    # FFmpeg affiche la duree dans un format comme "Duration: 01:23:45.67"
    duration_match = re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', stderr)
    total_duration = 0
    if duration_match:
        h, m, s, ms = duration_match.groups()
        total_duration = int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 100

    print(f"STATUS: {len(silence_starts)} silences detectes dans {total_duration:.0f}s", file=sys.stderr)
    print("PROGRESS: 30", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 2 : Construction des blocs de parole (entre les silences)
    # ══════════════════════════════════════════════════════════════
    # Les blocs de parole sont les zones ENTRE les silences.
    # Exemple : si on a silence de 0-0.5s et silence de 2.3-2.8s,
    # alors il y a un bloc de parole de 0.5s a 2.3s.
    raw_blocks = []

    # Premier bloc : du debut de l'audio jusqu'au premier silence
    if silence_starts:
        if silence_starts[0] > 0.3:  # Ignorer si le silence commence tout de suite
            raw_blocks.append({'start': 0, 'end': round(silence_starts[0], 2)})
    else:
        # Pas de silence detecte = tout l'audio est de la parole
        raw_blocks.append({'start': 0, 'end': total_duration})

    # Blocs entre chaque fin de silence et le debut du silence suivant
    for i in range(len(silence_ends)):
        block_start = silence_ends[i]
        # Si c'est le dernier silence, le bloc va jusqu'a la fin de l'audio
        block_end = silence_starts[i + 1] if i + 1 < len(silence_starts) else total_duration

        # On ne garde que les blocs d'au moins 0.5 seconde
        if block_end - block_start >= 0.5:
            raw_blocks.append({
                'start': round(block_start, 2),
                'end': round(block_end, 2)
            })

    # ══════════════════════════════════════════════════════════════
    # Etape 3 : Detection des paires "nom + discours vernaculaire"
    # ══════════════════════════════════════════════════════════════
    # Dans un enregistrement linguistique, le pattern typique est :
    # - Un bloc court (< 1.5s) = le meneur dit le prenom/nom de l'intervenant
    # - Suivi d'un bloc plus long = l'intervenant parle en langue vernaculaire
    # Si le gap entre les deux est < 1.5s, on les considere comme une "paire".
    speech_blocks = []
    i = 0
    pair_id = 0  # Identifiant unique pour chaque paire detectee

    while i < len(raw_blocks):
        block = raw_blocks[i]
        dur = block['end'] - block['start']

        # Verifier si c'est un bloc court suivi d'un autre bloc avec un petit gap
        if dur < 1.5 and i + 1 < len(raw_blocks):
            next_block = raw_blocks[i + 1]
            gap = next_block['start'] - block['end']
            if gap < 1.5:
                # Paire detectee : 2 blocs distincts mais semantiquement lies
                speech_blocks.append({
                    'start': round(block['start'], 2),
                    'end': round(block['end'], 2),
                    'type': 'name',          # Bloc court = le meneur dit un prenom/nom
                    'pair_id': pair_id
                })
                speech_blocks.append({
                    'start': round(next_block['start'], 2),
                    'end': round(next_block['end'], 2),
                    'type': 'speech',        # Bloc long = phrase en langue vernaculaire
                    'pair_id': pair_id
                })
                pair_id += 1
                i += 2  # On saute les 2 blocs (deja traites)
                continue

        # Bloc normal (pas de paire detectee)
        speech_blocks.append({
            'start': round(block['start'], 2),
            'end': round(block['end'], 2),
            'type': 'unknown',  # Type non determine
            'pair_id': -1       # Pas de paire associee
        })
        i += 1

    print(f"STATUS: {len(speech_blocks)} blocs de parole", file=sys.stderr)
    print("PROGRESS: 50", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 4 : Regroupement en sequences
    # ══════════════════════════════════════════════════════════════
    # Une "sequence" = un tour complet : le meneur dit une phrase en francais,
    # puis chaque intervenant la repete en langue vernaculaire.
    # Un long silence (> sequence_gap) marque la fin d'une sequence.

    # Calcul des gaps entre blocs consecutifs
    gaps = []
    for i in range(1, len(speech_blocks)):
        gap = speech_blocks[i]['start'] - speech_blocks[i-1]['end']
        gaps.append(gap)

    # Calcul du gap median entre intervenants (petits gaps uniquement)
    # Cela donne une idee du rythme typique de l'enregistrement.
    small_gaps = [g for g in gaps if g < args.sequence_gap]
    if small_gaps:
        median_gap = sorted(small_gaps)[len(small_gaps) // 2]
    else:
        median_gap = 0.5

    print(f"STATUS: Gap median entre intervenants: {median_gap:.2f}s", file=sys.stderr)

    # --- Construction des sequences ---
    # Le premier bloc de chaque groupe = meneur (leader), les suivants = variantes
    sequences = []
    current_blocks = [speech_blocks[0]]  # Commence avec le premier bloc

    for i in range(1, len(speech_blocks)):
        gap = speech_blocks[i]['start'] - speech_blocks[i-1]['end']

        if gap >= args.sequence_gap:
            # Long silence detecte = fin de la sequence courante
            if len(current_blocks) >= 2:
                sequences.append({
                    'leader': current_blocks[0],      # Premier bloc = meneur
                    'variants': current_blocks[1:]     # Blocs suivants = intervenants
                })
            # Debut d'une nouvelle sequence
            current_blocks = [speech_blocks[i]]
        else:
            # Petit gap = meme sequence, on ajoute le bloc
            current_blocks.append(speech_blocks[i])

    # Ne pas oublier la derniere sequence en cours
    if len(current_blocks) >= 2:
        sequences.append({
            'leader': current_blocks[0],
            'variants': current_blocks[1:]
        })

    print(f"STATUS: {len(sequences)} sequences brutes", file=sys.stderr)
    print("PROGRESS: 70", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Post-traitement : redecoupage des sequences trop longues
    # ══════════════════════════════════════════════════════════════
    # Si une sequence a plus de MAX_VARIANTS variantes, c'est probablement
    # que plusieurs phrases du meneur ont ete fusionnees (pas de long silence entre elles).
    # On les redecoupe en paquets de CHUNK_SIZE (~9 intervenants).
    MAX_VARIANTS = 10   # Seuil au-dela duquel on redecoupe
    CHUNK_SIZE = 9      # ~9 intervenants par phrase du meneur

    final_sequences = []
    for seq in sequences:
        if len(seq['variants']) <= MAX_VARIANTS:
            # Sequence de taille normale, on la garde telle quelle
            final_sequences.append(seq)
        else:
            # Trop de variantes = probablement plusieurs phrases fusionnees
            # On decoupe par paquets de CHUNK_SIZE
            variants = seq['variants']

            # Premier paquet : on garde le leader original
            first_chunk = variants[:CHUNK_SIZE]
            final_sequences.append({
                'leader': seq['leader'],
                'variants': first_chunk
            })

            # Paquets suivants : le premier bloc de chaque paquet devient le nouveau leader
            for k in range(CHUNK_SIZE, len(variants), CHUNK_SIZE):
                chunk = variants[k:k + CHUNK_SIZE]
                if len(chunk) >= 1:
                    final_sequences.append({
                        'leader': chunk[0],            # Premier bloc = nouveau meneur
                        'variants': chunk[1:] if len(chunk) > 1 else []
                    })

    sequences = final_sequences
    print(f"STATUS: {len(sequences)} sequences apres redecoupage", file=sys.stderr)
    print("PROGRESS: 80", file=sys.stderr)

    # --- Statistiques finales ---
    var_counts = [len(s['variants']) for s in sequences]
    print(f"STATUS: Variantes par sequence: min={min(var_counts) if var_counts else 0}, max={max(var_counts) if var_counts else 0}, moy={sum(var_counts)/len(var_counts):.1f}", file=sys.stderr)

    # --- Construction du JSON de sortie ---
    output = {
        'speech_blocks': speech_blocks,   # Tous les blocs de parole detectes
        'sequences': sequences,           # Les sequences leader + variantes
        'stats': {
            'total_duration': total_duration,
            'speech_blocks_count': len(speech_blocks),
            'sequences_count': len(sequences),
            'median_gap': round(median_gap, 3),
            'silence_threshold_db': args.silence_thresh,
            'sequence_gap_s': args.sequence_gap
        }
    }

    # Ecriture du fichier JSON et affichage sur stdout
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(json.dumps(output))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(sequences)} sequences, {len(speech_blocks)} blocs", file=sys.stderr)


# Point d'entree du script
if __name__ == '__main__':
    main()
