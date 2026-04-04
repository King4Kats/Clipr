#!/usr/bin/env python3
"""
VAD + Diarisation combines pour la transcription linguistique.

1. Silero VAD : detecte les zones de parole (segments reels bases sur les silences)
2. SpeechBrain ECAPA-TDNN : embedding de chaque segment VAD
3. Spectral clustering : assigne un speaker a chaque segment
4. Output : liste de tours de parole [{start, end, speaker}]

Usage:
    python vad-diarize.py <audio_path> --output <json> --num-speakers <N>
"""

import argparse
import json
import sys
import numpy as np


def main():
    parser = argparse.ArgumentParser(description='VAD + Diarisation')
    parser.add_argument('audio_path', help='Fichier audio (WAV)')
    parser.add_argument('--output', required=True, help='Fichier JSON de sortie')
    parser.add_argument('--num-speakers', type=int, default=0, help='Nombre de speakers (0=auto)')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement...", file=sys.stderr)

    import torch
    import soundfile as sf

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"STATUS: Device={device}", file=sys.stderr)

    # ── Charger l'audio ──
    print("STATUS: Chargement audio...", file=sys.stderr)
    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Resample a 16kHz si necessaire
    if sample_rate != 16000:
        import torchaudio
        waveform = torch.tensor(audio_data).unsqueeze(0)
        waveform = torchaudio.transforms.Resample(sample_rate, 16000)(waveform)
        audio_data = waveform.squeeze(0).numpy()
        sample_rate = 16000

    duration = len(audio_data) / sample_rate
    print(f"STATUS: Audio charge: {duration:.0f}s", file=sys.stderr)
    print("PROGRESS: 5", file=sys.stderr)

    # ── Step 1 : Silero VAD ──
    print("STATUS: Detection des zones de parole (VAD)...", file=sys.stderr)

    vad_model, vad_utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        trust_repo=True
    )

    (get_speech_timestamps, _, read_audio, _, _) = vad_utils

    # Convertir en tensor pour Silero
    audio_tensor = torch.tensor(audio_data)

    speech_timestamps = get_speech_timestamps(
        audio_tensor,
        vad_model,
        sampling_rate=sample_rate,
        min_speech_duration_ms=500,    # Segments de parole min 0.5s
        min_silence_duration_ms=300,   # Silence min 0.3s pour couper
        speech_pad_ms=100,             # Padding autour de la parole
        return_seconds=False           # Retourne en samples
    )

    # Convertir en secondes
    vad_segments = []
    for ts in speech_timestamps:
        start_s = ts['start'] / sample_rate
        end_s = ts['end'] / sample_rate
        if end_s - start_s >= 0.5:  # Garder segments >= 0.5s
            vad_segments.append({'start': round(start_s, 2), 'end': round(end_s, 2)})

    print(f"STATUS: {len(vad_segments)} segments de parole detectes", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    if len(vad_segments) < 2:
        _write_output(args.output, vad_segments)
        return

    # Liberer le modele VAD
    del vad_model
    import gc
    gc.collect()

    # ── Step 2 : Embeddings SpeechBrain sur chaque segment VAD ──
    print("STATUS: Chargement modele speaker...", file=sys.stderr)

    from speechbrain.inference.speaker import EncoderClassifier
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
        savedir="/data/temp/speechbrain_ecapa"
    )

    print("STATUS: Extraction embeddings...", file=sys.stderr)
    print("PROGRESS: 30", file=sys.stderr)

    waveform = torch.tensor(audio_data).unsqueeze(0)
    embeddings = []
    valid_indices = []

    for i, seg in enumerate(vad_segments):
        start_sample = int(seg['start'] * sample_rate)
        end_sample = int(seg['end'] * sample_rate)
        chunk = waveform[:, start_sample:end_sample]

        if chunk.shape[1] < sample_rate * 0.3:
            embeddings.append(None)
            continue

        with torch.no_grad():
            emb = classifier.encode_batch(chunk.to(device))
            embeddings.append(emb.squeeze().cpu().numpy())
        valid_indices.append(i)

        if i % 20 == 0:
            progress = 30 + int((i / len(vad_segments)) * 40)
            print(f"PROGRESS: {progress}", file=sys.stderr)

    # Liberer SpeechBrain
    del classifier
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

    print("PROGRESS: 70", file=sys.stderr)
    print("STATUS: Clustering speakers...", file=sys.stderr)

    # ── Step 3 : Clustering ──
    valid_embeddings = [e for e in embeddings if e is not None]

    if len(valid_embeddings) < 2:
        for seg in vad_segments:
            seg['speaker'] = 'SPEAKER_0'
        _write_output(args.output, vad_segments)
        return

    emb_matrix = np.stack(valid_embeddings)

    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import SpectralClustering

    similarity = cosine_similarity(emb_matrix)
    similarity = (similarity + 1) / 2

    if args.num_speakers > 0:
        n_speakers = min(args.num_speakers, len(valid_embeddings))
    else:
        n_speakers = _estimate_num_speakers(similarity, max_speakers=min(8, len(valid_embeddings)))

    print(f"STATUS: {n_speakers} speakers", file=sys.stderr)

    clustering = SpectralClustering(
        n_clusters=n_speakers,
        affinity='precomputed',
        random_state=42
    ).fit(similarity)

    labels = clustering.labels_

    # Assigner les labels aux segments VAD
    label_idx = 0
    for i, seg in enumerate(vad_segments):
        if embeddings[i] is not None:
            seg['speaker'] = f'SPEAKER_{labels[label_idx]}'
            label_idx += 1
        else:
            # Segment trop court : heriter du voisin
            seg['speaker'] = _inherit(vad_segments, i)

    print("PROGRESS: 90", file=sys.stderr)

    # ── Step 4 : Merger les segments contigus du meme speaker ──
    print("STATUS: Fusion des tours de parole...", file=sys.stderr)
    merged = []
    for seg in vad_segments:
        last = merged[-1] if merged else None
        if last and last['speaker'] == seg['speaker'] and seg['start'] - last['end'] < 1.0:
            last['end'] = seg['end']
        else:
            merged.append(dict(seg))

    print(f"STATUS: {len(merged)} tours de parole (avant merge: {len(vad_segments)})", file=sys.stderr)

    _write_output(args.output, merged)


def _write_output(output_path, turns):
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(turns, f, ensure_ascii=False, indent=2)
    print(json.dumps(turns))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(turns)} tours", file=sys.stderr)


def _inherit(segments, idx):
    for offset in range(1, len(segments)):
        if idx - offset >= 0 and 'speaker' in segments[idx - offset]:
            return segments[idx - offset]['speaker']
        if idx + offset < len(segments) and 'speaker' in segments[idx + offset]:
            return segments[idx + offset]['speaker']
    return 'SPEAKER_0'


def _estimate_num_speakers(similarity_matrix, max_speakers=8):
    n = similarity_matrix.shape[0]
    if n <= 2:
        return min(2, n)
    max_k = min(max_speakers, n)
    from scipy.sparse.csgraph import laplacian
    L = laplacian(similarity_matrix, normed=True)
    try:
        eigenvalues = np.sort(np.real(np.linalg.eigvals(L)))
    except:
        return 2
    eigenvalues = eigenvalues[:max_k + 1]
    gaps = np.diff(eigenvalues)
    if len(gaps) < 2:
        return 2
    best_k = np.argmax(gaps[1:]) + 2
    return max(2, min(best_k, max_speakers))


if __name__ == '__main__':
    main()
