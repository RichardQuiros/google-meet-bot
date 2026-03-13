#!/usr/bin/env python3
import argparse
import json
import os

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--model", default=os.getenv("FASTER_WHISPER_MODEL", "small"))
    parser.add_argument("--device", default=os.getenv("FASTER_WHISPER_DEVICE", "cpu"))
    parser.add_argument(
        "--compute-type",
        default=os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8"),
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=int(os.getenv("FASTER_WHISPER_BEAM_SIZE", "5")),
    )
    parser.add_argument(
        "--speaker",
        default=os.getenv("STT_DEFAULT_SPEAKER", "Unknown speaker"),
    )
    args = parser.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(args.input, beam_size=args.beam_size, vad_filter=True)

    payload = {
        "language": info.language,
        "segments": [
            {
                "text": segment.text.strip(),
                "speaker": args.speaker,
            }
            for segment in segments
            if segment.text and segment.text.strip()
        ],
    }

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
