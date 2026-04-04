#!/usr/bin/env python3
"""
Speaker diarization using sliding window embeddings on raw audio.

Approach: slice audio into fixed 1.5s windows, extract ECAPA-TDNN embeddings
in batch on GPU, cluster with spectral clustering, then assign each Whisper
segment to a speaker by maximum temporal overlap.

Works efficiently on any duration (30min to 3h+) because window count
scales linearly and GPU batching keeps it fast.
"""

import argparse
import json
import sys
import numpy as np


# ── Config ──
WINDOW_SEC = 1.5
HOP_SEC = 0.75
MIN_WINDOW_SAMPLES = 4000  # ~0.25s at 16kHz
BATCH_SIZE = 64


def main():
    parser = argparse.ArgumentParser(description='Speaker diarization for transcript segments')
    parser.add_argument('audio_path', help='Path to audio file (WAV preferred)')
    parser.add_argument('--segments', required=True, help='Path to JSON file with Whisper segments')
    parser.add_argument('--output', required=True, help='Output JSON path')
    parser.add_argument('--num-speakers', type=int, default=0, help='Expected number of speakers (0=auto-detect)')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Loading diarization model...", file=sys.stderr)

    import torch
    import soundfile as sf

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f"STATUS: Using device: {device}", file=sys.stderr)

    # Load Whisper segments
    with open(args.segments, 'r', encoding='utf-8') as f:
        segments = json.load(f)

    if len(segments) < 2:
        for seg in segments:
            seg['speaker'] = 'SPEAKER_0'
        _write_output(args.output, segments)
        return

    # ── Step 1: Load audio ──
    print("STATUS: Loading audio...", file=sys.stderr)
    print("PROGRESS: 5", file=sys.stderr)

    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Resample to 16kHz if needed
    if sample_rate != 16000:
        import torchaudio
        waveform = torch.tensor(audio_data).unsqueeze(0)
        waveform = torchaudio.transforms.Resample(sample_rate, 16000)(waveform)
        audio_data = waveform.squeeze(0).numpy()
        sample_rate = 16000

    total_samples = len(audio_data)
    duration_sec = total_samples / sample_rate
    print(f"STATUS: Audio loaded: {duration_sec:.0f}s", file=sys.stderr)

    # ── Step 2: Create sliding windows ──
    print("STATUS: Creating audio windows...", file=sys.stderr)
    print("PROGRESS: 10", file=sys.stderr)

    window_samples = int(WINDOW_SEC * sample_rate)
    hop_samples = int(HOP_SEC * sample_rate)

    windows = []  # list of (start_sec, end_sec, audio_chunk)
    pos = 0
    while pos + MIN_WINDOW_SAMPLES < total_samples:
        end = min(pos + window_samples, total_samples)
        chunk = audio_data[pos:end]
        if len(chunk) >= MIN_WINDOW_SAMPLES:
            windows.append((pos / sample_rate, end / sample_rate, chunk))
        pos += hop_samples

    n_windows = len(windows)
    print(f"STATUS: {n_windows} windows ({WINDOW_SEC}s, {HOP_SEC}s hop)", file=sys.stderr)

    # ── Step 3: Load model + batch embed ──
    print("STATUS: Loading speaker embedding model...", file=sys.stderr)
    print("PROGRESS: 15", file=sys.stderr)

    from speechbrain.inference.speaker import EncoderClassifier
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
        savedir="/data/temp/speechbrain_ecapa"
    )

    print("STATUS: Extracting embeddings...", file=sys.stderr)
    print("PROGRESS: 25", file=sys.stderr)

    all_embeddings = []
    for batch_start in range(0, n_windows, BATCH_SIZE):
        batch_end = min(batch_start + BATCH_SIZE, n_windows)
        batch_chunks = [windows[i][2] for i in range(batch_start, batch_end)]

        # Pad to same length for batching
        max_len = max(len(c) for c in batch_chunks)
        padded = np.zeros((len(batch_chunks), max_len), dtype=np.float32)
        for i, c in enumerate(batch_chunks):
            padded[i, :len(c)] = c

        batch_tensor = torch.tensor(padded).to(device)
        with torch.no_grad():
            embs = classifier.encode_batch(batch_tensor)
            all_embeddings.append(embs.cpu().numpy())

        progress = 25 + int(((batch_end) / n_windows) * 40)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    embeddings = np.concatenate(all_embeddings, axis=0)
    # Squeeze extra dims: (N, 1, D) -> (N, D)
    if embeddings.ndim == 3:
        embeddings = embeddings.squeeze(1)

    print(f"STATUS: {embeddings.shape[0]} embeddings extracted (dim={embeddings.shape[1]})", file=sys.stderr)
    print("PROGRESS: 65", file=sys.stderr)

    # Free model GPU memory before clustering
    del classifier
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    # ── Step 4: Cluster speakers ──
    print("STATUS: Clustering speakers...", file=sys.stderr)
    print("PROGRESS: 70", file=sys.stderr)

    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import SpectralClustering

    similarity = cosine_similarity(embeddings)
    similarity = (similarity + 1) / 2  # map to [0, 1]

    if args.num_speakers > 0:
        n_speakers = min(args.num_speakers, len(embeddings))
    else:
        n_speakers = _estimate_num_speakers(similarity, max_speakers=min(6, len(embeddings)))
        print(f"STATUS: Auto-detected {n_speakers} speakers", file=sys.stderr)

    clustering = SpectralClustering(
        n_clusters=n_speakers,
        affinity='precomputed',
        random_state=42
    ).fit(similarity)

    window_labels = clustering.labels_  # one label per window

    # Lissage des labels par vote majoritaire sur fenetre glissante
    # Evite les oscillations de speaker sur les frontieres
    # 7 fenetres de 0.75s hop = ~5 secondes de contexte
    SMOOTH_WINDOW = 7
    smoothed_labels = _smooth_labels(window_labels, SMOOTH_WINDOW)
    print(f"STATUS: Labels lisses (fenetre={SMOOTH_WINDOW})", file=sys.stderr)

    # Construction de la timeline avec labels lisses
    speaker_timeline = []
    for i, (start_s, end_s, _) in enumerate(windows):
        speaker_timeline.append((start_s, end_s, f'SPEAKER_{smoothed_labels[i]}'))

    print("PROGRESS: 80", file=sys.stderr)

    # ── Step 5: Assign speakers to Whisper segments by overlap ──
    print("STATUS: Assigning speakers to segments...", file=sys.stderr)

    for seg in segments:
        seg_start = seg['start']
        seg_end = seg['end']

        # Count overlap per speaker
        speaker_overlap = {}
        for w_start, w_end, w_speaker in speaker_timeline:
            overlap = max(0, min(seg_end, w_end) - max(seg_start, w_start))
            if overlap > 0:
                speaker_overlap[w_speaker] = speaker_overlap.get(w_speaker, 0) + overlap

        if speaker_overlap:
            seg['speaker'] = max(speaker_overlap, key=speaker_overlap.get)
        else:
            seg['speaker'] = 'SPEAKER_0'

    print("PROGRESS: 95", file=sys.stderr)
    print("STATUS: Finalizing...", file=sys.stderr)

    _write_output(args.output, segments)


def _write_output(output_path, segments):
    """Write results to file and stdout."""
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)
    print(json.dumps(segments))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! Assigned speakers to {len(segments)} segments", file=sys.stderr)


def _smooth_labels(labels, window_size=5):
    """
    Lissage des labels de speaker par vote majoritaire.
    Pour chaque position, on regarde les `window_size` labels autour
    et on prend le plus frequent. Ca elimine les oscillations sur les frontieres.
    """
    from collections import Counter
    smoothed = labels.copy()
    half = window_size // 2

    for i in range(len(labels)):
        start = max(0, i - half)
        end = min(len(labels), i + half + 1)
        neighborhood = labels[start:end]
        # Vote majoritaire
        counter = Counter(neighborhood)
        smoothed[i] = counter.most_common(1)[0][0]

    return smoothed


def _estimate_num_speakers(similarity_matrix, max_speakers=6):
    """Estimate number of speakers using eigenvalue gap heuristic."""
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
