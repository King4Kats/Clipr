#!/usr/bin/env python3
"""
DIARIZE.PY : Diarisation des locuteurs (qui parle quand ?).

Ce script identifie les differents locuteurs dans un fichier audio et assigne
un label de locuteur (SPEAKER_0, SPEAKER_1, etc.) a chaque segment de transcription
Whisper existant.

Approche technique en 5 etapes :
1. Charger l'audio et le decouper en fenetres glissantes de 1.5 secondes
2. Extraire un "embedding" (vecteur numerique) pour chaque fenetre avec le modele
   ECAPA-TDNN de SpeechBrain (ce vecteur represente l'identite vocale du locuteur)
3. Regrouper les embeddings similaires avec du clustering spectral
   (les fenetres d'un meme locuteur auront des vecteurs proches)
4. Lisser les labels pour eviter les oscillations aux frontieres
5. Assigner un locuteur a chaque segment Whisper par chevauchement temporel

Fonctionne efficacement sur des audios de 30 minutes a 3 heures+ car le nombre
de fenetres croit lineairement et le traitement GPU par lots (batching) est rapide.

Usage :
    python diarize.py <audio_path> --segments <json> --output <json> --num-speakers <N>
"""

# --- Imports standards ---
# argparse : arguments en ligne de commande
# json     : lecture/ecriture JSON
# sys      : ecriture sur stderr (progression)
# numpy    : calculs numeriques (matrices d'embeddings, similarite cosinus, etc.)
import argparse
import json
import sys
import numpy as np


# ── Configuration des fenetres glissantes ──
# WINDOW_SEC : duree de chaque fenetre d'analyse (1.5 secondes)
#   -> Assez long pour capter l'identite vocale, assez court pour une bonne resolution temporelle
WINDOW_SEC = 1.5
# HOP_SEC : decalage entre deux fenetres consecutives (0.75 secondes = 50% de chevauchement)
#   -> Le chevauchement ameliore la precision aux frontieres entre locuteurs
HOP_SEC = 0.75
# MIN_WINDOW_SAMPLES : nombre minimum d'echantillons pour qu'une fenetre soit valide
#   -> ~0.25 seconde a 16kHz, en dessous l'embedding serait trop bruit
MIN_WINDOW_SAMPLES = 4000
# BATCH_SIZE : nombre de fenetres traitees simultanement par le GPU
#   -> 64 est un bon compromis entre vitesse et utilisation memoire
BATCH_SIZE = 64


def main():
    """
    Fonction principale : charge l'audio, extrait les embeddings, clusterise
    les locuteurs, puis assigne un speaker a chaque segment Whisper.
    """

    # --- Arguments en ligne de commande ---
    parser = argparse.ArgumentParser(description='Speaker diarization for transcript segments')
    parser.add_argument('audio_path', help='Path to audio file (WAV preferred)')
    # --segments : fichier JSON contenant les segments Whisper (debut, fin, texte)
    parser.add_argument('--segments', required=True, help='Path to JSON file with Whisper segments')
    parser.add_argument('--output', required=True, help='Output JSON path')
    # --num-speakers : si on connait le nombre de locuteurs a l'avance (0 = detection auto)
    parser.add_argument('--num-speakers', type=int, default=0, help='Expected number of speakers (0=auto-detect)')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Loading diarization model...", file=sys.stderr)

    # --- Import des librairies lourdes (chargees ici pour un demarrage rapide) ---
    # torch      : framework de deep learning (calculs GPU, tenseurs)
    # soundfile  : lecture de fichiers audio (WAV, FLAC, etc.)
    import torch
    import soundfile as sf

    # Detection automatique du device (CPU ou GPU CUDA)
    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f"STATUS: Using device: {device}", file=sys.stderr)

    # --- Chargement des segments Whisper ---
    # Ces segments ont ete produits par transcribe.py et contiennent
    # le texte, le debut et la fin de chaque phrase detectee.
    with open(args.segments, 'r', encoding='utf-8') as f:
        segments = json.load(f)

    # Cas trivial : s'il y a moins de 2 segments, pas besoin de diarisation
    # On assigne simplement SPEAKER_0 a tout.
    if len(segments) < 2:
        for seg in segments:
            seg['speaker'] = 'SPEAKER_0'
        _write_output(args.output, segments)
        return

    # ══════════════════════════════════════════════════════════════
    # Etape 1 : Chargement de l'audio
    # ══════════════════════════════════════════════════════════════
    print("STATUS: Loading audio...", file=sys.stderr)
    print("PROGRESS: 5", file=sys.stderr)

    # Lecture du fichier audio en float32 (valeurs entre -1 et 1)
    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')

    # Si l'audio est stereo (2 canaux), on le convertit en mono
    # en faisant la moyenne des deux canaux
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Reeechantillonnage a 16kHz si necessaire
    # Le modele ECAPA-TDNN attend de l'audio a 16000 Hz
    if sample_rate != 16000:
        import torchaudio
        waveform = torch.tensor(audio_data).unsqueeze(0)
        waveform = torchaudio.transforms.Resample(sample_rate, 16000)(waveform)
        audio_data = waveform.squeeze(0).numpy()
        sample_rate = 16000

    total_samples = len(audio_data)
    duration_sec = total_samples / sample_rate
    print(f"STATUS: Audio loaded: {duration_sec:.0f}s", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 2 : Creation des fenetres glissantes
    # ══════════════════════════════════════════════════════════════
    # On decoupe l'audio en fenetres de 1.5s avec un pas de 0.75s.
    # Chaque fenetre sera analysee independamment pour extraire
    # une "empreinte vocale" (embedding).
    print("STATUS: Creating audio windows...", file=sys.stderr)
    print("PROGRESS: 10", file=sys.stderr)

    window_samples = int(WINDOW_SEC * sample_rate)  # 1.5s * 16000 = 24000 echantillons
    hop_samples = int(HOP_SEC * sample_rate)         # 0.75s * 16000 = 12000 echantillons

    windows = []  # Liste de tuples (debut_sec, fin_sec, chunk_audio)
    pos = 0
    while pos + MIN_WINDOW_SAMPLES < total_samples:
        end = min(pos + window_samples, total_samples)
        chunk = audio_data[pos:end]
        # On ne garde que les fenetres assez longues pour etre significatives
        if len(chunk) >= MIN_WINDOW_SAMPLES:
            windows.append((pos / sample_rate, end / sample_rate, chunk))
        pos += hop_samples

    n_windows = len(windows)
    print(f"STATUS: {n_windows} windows ({WINDOW_SEC}s, {HOP_SEC}s hop)", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 3 : Chargement du modele + extraction des embeddings par lots
    # ══════════════════════════════════════════════════════════════
    # ECAPA-TDNN est un reseau de neurones entraine pour reconnaitre les voix.
    # Pour chaque fenetre audio, il produit un vecteur de 192 dimensions
    # qui capture l'identite du locuteur (timbre, rythme, etc.).
    print("STATUS: Loading speaker embedding model...", file=sys.stderr)
    print("PROGRESS: 15", file=sys.stderr)

    from speechbrain.inference.speaker import EncoderClassifier
    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
        savedir="/data/temp/speechbrain_ecapa"  # Cache local du modele
    )

    print("STATUS: Extracting embeddings...", file=sys.stderr)
    print("PROGRESS: 25", file=sys.stderr)

    # Traitement par lots (batches) pour exploiter le parallelisme du GPU
    all_embeddings = []
    for batch_start in range(0, n_windows, BATCH_SIZE):
        batch_end = min(batch_start + BATCH_SIZE, n_windows)
        # Extraire les chunks audio du lot courant
        batch_chunks = [windows[i][2] for i in range(batch_start, batch_end)]

        # Padding : toutes les fenetres du lot doivent avoir la meme longueur
        # (necessite du GPU/tenseur). On complete les plus courtes avec des zeros.
        max_len = max(len(c) for c in batch_chunks)
        padded = np.zeros((len(batch_chunks), max_len), dtype=np.float32)
        for i, c in enumerate(batch_chunks):
            padded[i, :len(c)] = c

        # Conversion en tenseur PyTorch et envoi sur le device (CPU ou GPU)
        batch_tensor = torch.tensor(padded).to(device)
        # Extraction des embeddings sans calcul de gradient (inference uniquement)
        with torch.no_grad():
            embs = classifier.encode_batch(batch_tensor)
            # On ramene les embeddings sur CPU et en numpy pour le clustering
            all_embeddings.append(embs.cpu().numpy())

        # Mise a jour de la progression (de 25% a 65%)
        progress = 25 + int(((batch_end) / n_windows) * 40)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    # Concatenation de tous les lots en une seule matrice
    embeddings = np.concatenate(all_embeddings, axis=0)
    # Le modele SpeechBrain retourne parfois (N, 1, D), on le transforme en (N, D)
    if embeddings.ndim == 3:
        embeddings = embeddings.squeeze(1)

    print(f"STATUS: {embeddings.shape[0]} embeddings extracted (dim={embeddings.shape[1]})", file=sys.stderr)
    print("PROGRESS: 65", file=sys.stderr)

    # --- Liberation de la memoire GPU du modele d'embedding ---
    # Le clustering se fait sur CPU, donc on libere le GPU.
    del classifier
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    # ══════════════════════════════════════════════════════════════
    # Etape 4 : Clustering des locuteurs
    # ══════════════════════════════════════════════════════════════
    # On regroupe les embeddings similaires avec le clustering spectral.
    # L'idee : deux fenetres du meme locuteur auront des embeddings proches
    # (cosine similarity elevee), donc elles seront dans le meme cluster.
    print("STATUS: Clustering speakers...", file=sys.stderr)
    print("PROGRESS: 70", file=sys.stderr)

    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.cluster import SpectralClustering

    # Calcul de la matrice de similarite cosinus entre tous les embeddings
    # similarity[i][j] = cosinus entre l'embedding i et j (de -1 a 1)
    similarity = cosine_similarity(embeddings)
    # Normalisation dans [0, 1] pour le clustering spectral
    # (qui attend des "affinites" positives)
    similarity = (similarity + 1) / 2

    # Determination du nombre de locuteurs
    if args.num_speakers > 0:
        # L'utilisateur a specifie le nombre de locuteurs
        n_speakers = min(args.num_speakers, len(embeddings))
    else:
        # Detection automatique basee sur l'heuristique des valeurs propres
        # (voir la fonction _estimate_num_speakers plus bas)
        n_speakers = _estimate_num_speakers(similarity, max_speakers=min(6, len(embeddings)))
        print(f"STATUS: Auto-detected {n_speakers} speakers", file=sys.stderr)

    # Clustering spectral : algorithme qui utilise les valeurs propres de la matrice
    # de similarite pour trouver les groupes naturels dans les donnees.
    # affinity='precomputed' signifie qu'on fournit directement la matrice de similarite.
    clustering = SpectralClustering(
        n_clusters=n_speakers,
        affinity='precomputed',
        random_state=42  # Pour des resultats reproductibles
    ).fit(similarity)

    window_labels = clustering.labels_  # Un label (0, 1, 2...) par fenetre

    # --- Lissage des labels par vote majoritaire ---
    # Sans lissage, les labels peuvent osciller rapidement aux frontieres
    # entre deux locuteurs (ex: SPEAKER_0, SPEAKER_1, SPEAKER_0, SPEAKER_1...).
    # Le lissage regarde les 7 fenetres voisines (~5 secondes) et prend
    # le label le plus frequent, ce qui elimine les oscillations.
    SMOOTH_WINDOW = 7
    smoothed_labels = _smooth_labels(window_labels, SMOOTH_WINDOW)
    print(f"STATUS: Labels lisses (fenetre={SMOOTH_WINDOW})", file=sys.stderr)

    # Construction de la timeline des locuteurs avec les labels lisses
    # Chaque entree : (debut_sec, fin_sec, "SPEAKER_X")
    speaker_timeline = []
    for i, (start_s, end_s, _) in enumerate(windows):
        speaker_timeline.append((start_s, end_s, f'SPEAKER_{smoothed_labels[i]}'))

    print("PROGRESS: 80", file=sys.stderr)

    # ══════════════════════════════════════════════════════════════
    # Etape 5 : Assignation des locuteurs aux segments Whisper
    # ══════════════════════════════════════════════════════════════
    # Pour chaque segment Whisper, on regarde quelles fenetres de la timeline
    # le chevauchent, et on assigne le locuteur qui a le plus de chevauchement.
    print("STATUS: Assigning speakers to segments...", file=sys.stderr)

    for seg in segments:
        seg_start = seg['start']
        seg_end = seg['end']

        # Calcul du chevauchement temporel entre le segment et chaque fenetre
        speaker_overlap = {}
        for w_start, w_end, w_speaker in speaker_timeline:
            # Formule du chevauchement : max(0, min(fin1, fin2) - max(debut1, debut2))
            overlap = max(0, min(seg_end, w_end) - max(seg_start, w_start))
            if overlap > 0:
                speaker_overlap[w_speaker] = speaker_overlap.get(w_speaker, 0) + overlap

        # Le locuteur assigne est celui qui a le plus grand chevauchement total
        if speaker_overlap:
            seg['speaker'] = max(speaker_overlap, key=speaker_overlap.get)
        else:
            # Aucun chevauchement trouve (segment tres court ou hors limites)
            seg['speaker'] = 'SPEAKER_0'

    print("PROGRESS: 95", file=sys.stderr)
    print("STATUS: Finalizing...", file=sys.stderr)

    _write_output(args.output, segments)


def _write_output(output_path, segments):
    """
    Ecrit les segments avec leurs labels de locuteur dans un fichier JSON et sur stdout.

    Parametres :
        output_path : chemin du fichier de sortie
        segments    : liste de segments Whisper enrichis avec le champ 'speaker'
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)
    print(json.dumps(segments))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! Assigned speakers to {len(segments)} segments", file=sys.stderr)


def _smooth_labels(labels, window_size=5):
    """
    Lissage des labels de locuteur par vote majoritaire sur une fenetre glissante.

    Pour chaque position i, on regarde les `window_size` labels voisins
    (centres sur i) et on prend le label le plus frequent.
    Cela elimine les "sauts" rapides de locuteur aux frontieres.

    Parametres :
        labels      : tableau numpy des labels (ex: [0, 0, 1, 0, 1, 1, 1])
        window_size : taille de la fenetre de lissage (impair de preference)

    Retourne :
        tableau numpy des labels lisses
    """
    from collections import Counter
    smoothed = labels.copy()
    half = window_size // 2

    for i in range(len(labels)):
        # Extraire le voisinage (en gerant les bords du tableau)
        start = max(0, i - half)
        end = min(len(labels), i + half + 1)
        neighborhood = labels[start:end]
        # Vote majoritaire : le label le plus frequent dans le voisinage gagne
        counter = Counter(neighborhood)
        smoothed[i] = counter.most_common(1)[0][0]

    return smoothed


def _estimate_num_speakers(similarity_matrix, max_speakers=6):
    """
    Estime automatiquement le nombre de locuteurs en utilisant l'heuristique
    du "saut de valeur propre" (eigengap heuristic).

    Principe : on calcule le laplacien de la matrice de similarite, puis
    ses valeurs propres. Le plus grand "saut" entre deux valeurs propres
    consecutives indique le nombre naturel de clusters (= locuteurs).

    Parametres :
        similarity_matrix : matrice de similarite cosinus (N x N)
        max_speakers      : nombre maximum de locuteurs a considerer

    Retourne :
        nombre estime de locuteurs (minimum 2)
    """
    n = similarity_matrix.shape[0]
    if n <= 2:
        return min(2, n)

    max_k = min(max_speakers, n)

    # Calcul du laplacien normalise de la matrice de similarite
    from scipy.sparse.csgraph import laplacian
    L = laplacian(similarity_matrix, normed=True)
    try:
        # Calcul des valeurs propres du laplacien
        eigenvalues = np.sort(np.real(np.linalg.eigvals(L)))
    except:
        return 2

    # On ne garde que les max_k+1 premieres valeurs propres
    eigenvalues = eigenvalues[:max_k + 1]
    # Calcul des "sauts" (differences consecutives)
    gaps = np.diff(eigenvalues)
    if len(gaps) < 2:
        return 2

    # Le plus grand saut (en ignorant le premier) indique le nombre de clusters
    # On ajoute 2 car on commence a l'indice 1 des gaps et le nombre de clusters = indice + 1
    best_k = np.argmax(gaps[1:]) + 2
    return max(2, min(best_k, max_speakers))


# Point d'entree du script
if __name__ == '__main__':
    main()
