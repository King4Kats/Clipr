#!/usr/bin/env python3
"""
VAD-DIARIZE.PY : Combinaison de la detection d'activite vocale (VAD) et de la diarisation.

Ce script est une version amelioree de diarize.py. Au lieu de decouper l'audio
en fenetres fixes, il utilise d'abord un modele VAD (Voice Activity Detection)
pour detecter les zones de parole reelles, puis effectue la diarisation
uniquement sur ces zones.

Pipeline en 4 etapes :
1. Silero VAD : detecte les zones de parole reelles (basees sur les silences)
2. SpeechBrain ECAPA-TDNN : extrait un embedding (empreinte vocale) pour chaque zone
3. Clustering spectral : regroupe les zones par locuteur
4. Fusion : merge les zones consecutives du meme locuteur

Avantage par rapport a diarize.py : les segments suivent les frontieres naturelles
de la parole (pauses, silences), ce qui donne des decoupages plus propres.

Usage :
    python vad-diarize.py <audio_path> --output <json> --num-speakers <N>

Sortie JSON :
    [{"start": 0.5, "end": 3.2, "speaker": "SPEAKER_0"}, ...]
"""

# --- Imports standards ---
import argparse
import json
import sys
import numpy as np


def main():
    """
    Fonction principale : detecte la parole avec VAD, extrait les embeddings,
    clusterise les locuteurs, et fusionne les tours de parole contigus.
    """

    # --- Arguments en ligne de commande ---
    parser = argparse.ArgumentParser(description='VAD + Diarisation')
    parser.add_argument('audio_path', help='Fichier audio (WAV)')
    parser.add_argument('--output', required=True, help='Fichier JSON de sortie')
    # --num-speakers : nombre de locuteurs attendu (0 = detection automatique)
    parser.add_argument('--num-speakers', type=int, default=0, help='Nombre de speakers (0=auto)')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Chargement...", file=sys.stderr)

    # --- Import des librairies lourdes ---
    import torch
    import soundfile as sf

    # Detection automatique CPU/GPU
    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"STATUS: Device={device}", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Chargement de l'audio
    # ══════════════════════════════════════════════════════════════
    print("STATUS: Chargement audio...", file=sys.stderr)
    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')

    # Conversion stereo -> mono si necessaire
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Reeechantillonnage a 16kHz (frequence attendue par les modeles VAD et speaker)
    if sample_rate != 16000:
        import torchaudio
        waveform = torch.tensor(audio_data).unsqueeze(0)
        waveform = torchaudio.transforms.Resample(sample_rate, 16000)(waveform)
        audio_data = waveform.squeeze(0).numpy()
        sample_rate = 16000

    duration = len(audio_data) / sample_rate
    print(f"STATUS: Audio charge: {duration:.0f}s", file=sys.stderr)
    print("PROGRESS: 5", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 1 : Detection des zones de parole avec Silero VAD
    # ══════════════════════════════════════════════════════════════
    # Silero VAD est un modele leger et rapide qui distingue la parole
    # du silence/bruit. Il retourne les timestamps de debut et fin
    # de chaque zone de parole.
    print("STATUS: Detection des zones de parole (VAD)...", file=sys.stderr)

    # Chargement du modele Silero VAD depuis le hub PyTorch
    vad_model, vad_utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,  # Utiliser le cache si disponible
        trust_repo=True
    )

    # Extraction des fonctions utilitaires du modele VAD
    # get_speech_timestamps : detecte les zones de parole
    # Les autres fonctions (_) ne sont pas utilisees ici
    (get_speech_timestamps, _, read_audio, _, _) = vad_utils

    # Conversion de l'audio numpy en tenseur PyTorch pour Silero
    audio_tensor = torch.tensor(audio_data)

    # Detection des zones de parole avec les parametres suivants :
    speech_timestamps = get_speech_timestamps(
        audio_tensor,
        vad_model,
        sampling_rate=sample_rate,
        min_speech_duration_ms=500,    # Ignorer les bruits < 0.5 seconde
        min_silence_duration_ms=300,   # Silence de 0.3s minimum pour couper
        speech_pad_ms=100,             # Ajouter 100ms de marge autour de la parole
        return_seconds=False           # Retourner les positions en echantillons (pas en secondes)
    )

    # Conversion des positions en echantillons vers des secondes
    vad_segments = []
    for ts in speech_timestamps:
        start_s = ts['start'] / sample_rate
        end_s = ts['end'] / sample_rate
        # On ne garde que les segments d'au moins 0.5 seconde
        # (les segments trop courts ne contiennent pas assez d'info pour la diarisation)
        if end_s - start_s >= 0.5:
            vad_segments.append({'start': round(start_s, 2), 'end': round(end_s, 2)})

    print(f"STATUS: {len(vad_segments)} segments de parole detectes", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    # Cas trivial : moins de 2 segments, pas de diarisation possible
    if len(vad_segments) < 2:
        _write_output(args.output, vad_segments)
        return

    # Liberation du modele VAD (il n'est plus necessaire)
    del vad_model
    import gc
    gc.collect()

    # ══════════════════════════════════════════════════════════════
    # Etape 2 : Extraction des embeddings SpeechBrain sur chaque segment VAD
    # ══════════════════════════════════════════════════════════════
    # Pour chaque zone de parole detectee, on extrait un vecteur (embedding)
    # qui represente l'identite vocale du locuteur. Deux segments du meme
    # locuteur auront des embeddings proches.
    print("STATUS: Chargement modele speaker...", file=sys.stderr)

    from speechbrain.inference.speaker import EncoderClassifier
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
        savedir="/data/temp/speechbrain_ecapa"
    )

    print("STATUS: Extraction embeddings...", file=sys.stderr)
    print("PROGRESS: 30", file=sys.stderr)

    # Preparation de l'audio sous forme de tenseur pour SpeechBrain
    waveform = torch.tensor(audio_data).unsqueeze(0)
    embeddings = []      # Liste des embeddings (un par segment VAD)
    valid_indices = []   # Indices des segments pour lesquels on a pu extraire un embedding

    for i, seg in enumerate(vad_segments):
        # Extraction du morceau audio correspondant au segment VAD
        start_sample = int(seg['start'] * sample_rate)
        end_sample = int(seg['end'] * sample_rate)
        chunk = waveform[:, start_sample:end_sample]

        # Si le segment est trop court (< 0.3s), on saute l'extraction
        # (l'embedding serait trop bruite pour etre fiable)
        if chunk.shape[1] < sample_rate * 0.3:
            embeddings.append(None)
            continue

        # Extraction de l'embedding (sans calcul de gradient, mode inference)
        with torch.no_grad():
            emb = classifier.encode_batch(chunk.to(device))
            embeddings.append(emb.squeeze().cpu().numpy())
        valid_indices.append(i)

        # Progression toutes les 20 iterations
        if i % 20 == 0:
            progress = 30 + int((i / len(vad_segments)) * 40)
            print(f"PROGRESS: {progress}", file=sys.stderr)

    # Liberation du modele SpeechBrain et du cache GPU
    del classifier
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

    print("PROGRESS: 70", file=sys.stderr)
    print("STATUS: Clustering speakers...", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 3 : Clustering spectral des locuteurs
    # ══════════════════════════════════════════════════════════════
    # On regroupe les embeddings similaires pour identifier les locuteurs.

    # Filtrer les embeddings valides (ceux qui ne sont pas None)
    valid_embeddings = [e for e in embeddings if e is not None]

    # Cas trivial : moins de 2 embeddings valides
    if len(valid_embeddings) < 2:
        for seg in vad_segments:
            seg['speaker'] = 'SPEAKER_0'
        _write_output(args.output, vad_segments)
        return

    # Construction de la matrice d'embeddings (N segments x D dimensions)
    emb_matrix = np.stack(valid_embeddings)

    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import SpectralClustering

    # Calcul de la matrice de similarite cosinus et normalisation en [0, 1]
    similarity = cosine_similarity(emb_matrix)
    similarity = (similarity + 1) / 2

    # Determination du nombre de locuteurs (auto ou manuel)
    if args.num_speakers > 0:
        n_speakers = min(args.num_speakers, len(valid_embeddings))
    else:
        # Detection automatique par l'heuristique du saut de valeur propre
        n_speakers = _estimate_num_speakers(similarity, max_speakers=min(8, len(valid_embeddings)))

    print(f"STATUS: {n_speakers} speakers", file=sys.stderr)

    # Execution du clustering spectral
    clustering = SpectralClustering(
        n_clusters=n_speakers,
        affinity='precomputed',
        random_state=42
    ).fit(similarity)

    labels = clustering.labels_

    # --- Assignation des labels de locuteur aux segments VAD ---
    label_idx = 0
    for i, seg in enumerate(vad_segments):
        if embeddings[i] is not None:
            # Segment avec embedding valide : on utilise le label du clustering
            seg['speaker'] = f'SPEAKER_{labels[label_idx]}'
            label_idx += 1
        else:
            # Segment trop court (pas d'embedding) : on herite du locuteur
            # du segment voisin le plus proche qui a un label
            seg['speaker'] = _inherit(vad_segments, i)

    print("PROGRESS: 90", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 4 : Fusion des segments contigus du meme locuteur
    # ══════════════════════════════════════════════════════════════
    # Si deux segments consecutifs appartiennent au meme locuteur et sont
    # separes par moins d'1 seconde, on les fusionne en un seul tour de parole.
    # Cela produit des tours de parole plus naturels et plus lisibles.
    print("STATUS: Fusion des tours de parole...", file=sys.stderr)
    merged = []
    for seg in vad_segments:
        last = merged[-1] if merged else None
        # Conditions de fusion : meme locuteur ET ecart < 1 seconde
        if last and last['speaker'] == seg['speaker'] and seg['start'] - last['end'] < 1.0:
            last['end'] = seg['end']  # On etend le segment precedent
        else:
            merged.append(dict(seg))  # Nouveau tour de parole

    print(f"STATUS: {len(merged)} tours de parole (avant merge: {len(vad_segments)})", file=sys.stderr)

    _write_output(args.output, merged)


def _write_output(output_path, turns):
    """
    Ecrit les tours de parole dans un fichier JSON et sur stdout.

    Parametres :
        output_path : chemin du fichier de sortie
        turns       : liste de tours de parole [{start, end, speaker}, ...]
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(turns, f, ensure_ascii=False, indent=2)
    print(json.dumps(turns))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Termine ! {len(turns)} tours", file=sys.stderr)


def _inherit(segments, idx):
    """
    Pour un segment sans embedding (trop court), herite le label de locuteur
    du segment voisin le plus proche qui en a un.

    On cherche d'abord a gauche, puis a droite, en s'eloignant progressivement.

    Parametres :
        segments : liste complete des segments VAD
        idx      : index du segment sans label

    Retourne :
        le label du voisin le plus proche, ou 'SPEAKER_0' par defaut
    """
    for offset in range(1, len(segments)):
        # Chercher a gauche
        if idx - offset >= 0 and 'speaker' in segments[idx - offset]:
            return segments[idx - offset]['speaker']
        # Chercher a droite
        if idx + offset < len(segments) and 'speaker' in segments[idx + offset]:
            return segments[idx + offset]['speaker']
    return 'SPEAKER_0'


def _estimate_num_speakers(similarity_matrix, max_speakers=8):
    """
    Estime le nombre de locuteurs par l'heuristique du saut de valeur propre.

    Meme algorithme que dans diarize.py : on calcule le laplacien normalise
    de la matrice de similarite, puis on cherche le plus grand saut entre
    les valeurs propres consecutives.

    Parametres :
        similarity_matrix : matrice de similarite cosinus (N x N), valeurs dans [0, 1]
        max_speakers      : nombre maximum de locuteurs a considerer

    Retourne :
        nombre estime de locuteurs (minimum 2)
    """
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


# Point d'entree du script
if __name__ == '__main__':
    main()
