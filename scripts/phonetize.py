#!/usr/bin/env python3
"""
IPA phonetic transcription using Allosaurus.
Universal phone recognizer — works on any language including undocumented patois.

Usage:
    python phonetize.py <audio_path> --segments <json_path> --output <json_path>

Input segments JSON: [{"id": "0", "start": 1.5, "end": 3.2}, ...]
Output JSON: [{"id": "0", "ipa": "lu kat mĩʒɛ"}, ...]
"""

import argparse
import json
import sys
import os
import tempfile

def main():
    parser = argparse.ArgumentParser(description='IPA phonetic transcription via Allosaurus')
    parser.add_argument('audio_path', help='Path to audio file (WAV preferred)')
    parser.add_argument('--segments', required=True, help='JSON file with segments to phonetize [{id, start, end}]')
    parser.add_argument('--output', required=True, help='Output JSON path')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    args = parser.parse_args()

    print("PROGRESS: 0", file=sys.stderr)
    print("STATUS: Loading Allosaurus model...", file=sys.stderr)

    import torch
    import soundfile as sf
    import numpy as np

    device = args.device
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f"STATUS: Using device: {device}", file=sys.stderr)

    # Load Allosaurus
    from allosaurus.app import read_recognizer
    model = read_recognizer()

    print("PROGRESS: 15", file=sys.stderr)
    print("STATUS: Loading audio...", file=sys.stderr)

    # Load audio
    audio_data, sample_rate = sf.read(args.audio_path, dtype='float32')
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Load segments
    with open(args.segments, 'r', encoding='utf-8') as f:
        segments = json.load(f)

    if len(segments) == 0:
        _write_output(args.output, [])
        return

    print(f"STATUS: Phonetizing {len(segments)} segments...", file=sys.stderr)
    print("PROGRESS: 20", file=sys.stderr)

    results = []
    tmpdir = tempfile.mkdtemp()

    for i, seg in enumerate(segments):
        seg_id = seg.get('id', str(i))
        start = seg.get('start', 0)
        end = seg.get('end', 0)

        start_sample = int(start * sample_rate)
        end_sample = int(end * sample_rate)
        start_sample = max(0, start_sample)
        end_sample = min(len(audio_data), end_sample)

        if end_sample - start_sample < int(sample_rate * 0.1):
            # Segment too short
            results.append({"id": seg_id, "ipa": ""})
            continue

        # Write temp WAV for this segment
        chunk = audio_data[start_sample:end_sample]
        tmp_path = os.path.join(tmpdir, f"seg_{i}.wav")
        sf.write(tmp_path, chunk, sample_rate)

        try:
            # Allosaurus recognize
            ipa = model.recognize(tmp_path)
            results.append({"id": seg_id, "ipa": ipa.strip()})
        except Exception as e:
            print(f"ERROR: Segment {seg_id} failed: {e}", file=sys.stderr)
            results.append({"id": seg_id, "ipa": ""})

        # Cleanup temp file
        try:
            os.unlink(tmp_path)
        except:
            pass

        progress = 20 + int(((i + 1) / len(segments)) * 75)
        print(f"PROGRESS: {progress}", file=sys.stderr)

    # Cleanup temp dir
    try:
        os.rmdir(tmpdir)
    except:
        pass

    # Free GPU memory
    del model
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except:
        pass
    import gc
    gc.collect()

    print("PROGRESS: 95", file=sys.stderr)
    print("STATUS: Finalizing...", file=sys.stderr)

    _write_output(args.output, results)


def _write_output(output_path, results):
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(json.dumps(results))
    print("PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! {len(results)} segments phonetized", file=sys.stderr)


if __name__ == '__main__':
    main()
