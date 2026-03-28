#!/usr/bin/env python3
"""
Fast transcription script using faster-whisper.
4-8x faster than openai-whisper on CPU, even faster with GPU.

Usage:
    python transcribe.py <audio_path> --model <model> --language <lang> --output <json_path>

Install:
    pip install faster-whisper
"""

import argparse
import json
import sys
import os

def main():
    parser = argparse.ArgumentParser(description='Transcribe audio using faster-whisper')
    parser.add_argument('audio_path', help='Path to audio file')
    parser.add_argument('--model', default='large-v3', help='Model size: tiny, base, small, medium, large-v3, large-v3-turbo')
    parser.add_argument('--language', default='fr', help='Language code')
    parser.add_argument('--output', help='Output JSON path')
    parser.add_argument('--device', default='auto', help='Device: cpu, cuda, auto')
    parser.add_argument('--prompt', default='', help='Initial prompt to guide transcription with domain vocabulary')
    args = parser.parse_args()

    # Try faster-whisper first, fall back to openai-whisper
    try:
        from faster_whisper import WhisperModel
        use_faster = True
        print("WHISPER_ENGINE: faster-whisper", file=sys.stderr)
    except ImportError:
        try:
            import whisper
            use_faster = False
            print("WHISPER_ENGINE: openai-whisper (slower, install faster-whisper for 4-8x speedup)", file=sys.stderr)
        except ImportError:
            print("ERROR: No whisper library found. Install with: pip install faster-whisper", file=sys.stderr)
            sys.exit(1)

    # Determine output path
    if args.output:
        output_path = args.output
    else:
        base = os.path.splitext(args.audio_path)[0]
        output_path = base + '.json'

    print(f"PROGRESS: 0", file=sys.stderr)
    print(f"STATUS: Loading model {args.model}...", file=sys.stderr)

    if use_faster:
        # faster-whisper implementation
        device = args.device
        if device == 'auto':
            try:
                import torch
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            except:
                device = 'cpu'

        compute_type = 'float16' if device == 'cuda' else 'int8'

        print(f"STATUS: Using device: {device}, compute_type: {compute_type}", file=sys.stderr)

        model = WhisperModel(args.model, device=device, compute_type=compute_type)

        print(f"PROGRESS: 5", file=sys.stderr)
        print(f"STATUS: Transcribing...", file=sys.stderr)

        segments_list = []
        transcribe_kwargs = dict(
            language=args.language,
            beam_size=5,
            vad_filter=True,  # Filter out silence for faster processing
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        if args.prompt:
            transcribe_kwargs['initial_prompt'] = args.prompt
            print(f"STATUS: Using initial prompt ({len(args.prompt)} chars)", file=sys.stderr)

        segments_generator, info = model.transcribe(args.audio_path, **transcribe_kwargs)

        duration = info.duration

        for i, segment in enumerate(segments_generator):
            seg_data = {
                'id': i,
                'start': round(segment.start, 2),
                'end': round(segment.end, 2),
                'text': segment.text.strip()
            }
            segments_list.append(seg_data)

            # Report progress based on segment end time vs total duration
            if duration > 0:
                progress = min(95, int((segment.end / duration) * 95) + 5)
                print(f"PROGRESS: {progress}", file=sys.stderr)

            # Print segment for real-time display
            print(f"SEGMENT: {json.dumps(seg_data)}", file=sys.stderr)

    else:
        # openai-whisper fallback
        model = whisper.load_model(args.model)

        print(f"PROGRESS: 5", file=sys.stderr)
        print(f"STATUS: Transcribing (using slower openai-whisper)...", file=sys.stderr)

        transcribe_kwargs = dict(
            language=args.language,
            verbose=False,
        )
        if args.prompt:
            transcribe_kwargs['initial_prompt'] = args.prompt

        result = model.transcribe(args.audio_path, **transcribe_kwargs)

        segments_list = []
        for i, seg in enumerate(result.get('segments', [])):
            seg_data = {
                'id': i,
                'start': round(seg['start'], 2),
                'end': round(seg['end'], 2),
                'text': seg['text'].strip()
            }
            segments_list.append(seg_data)
            print(f"SEGMENT: {json.dumps(seg_data)}", file=sys.stderr)

    print(f"PROGRESS: 100", file=sys.stderr)
    print(f"STATUS: Done! {len(segments_list)} segments", file=sys.stderr)

    # Write output
    output_data = {
        'language': args.language,
        'segments': segments_list
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"OUTPUT: {output_path}", file=sys.stderr)

    # Also print to stdout for direct capture
    print(json.dumps(output_data))

if __name__ == '__main__':
    main()
