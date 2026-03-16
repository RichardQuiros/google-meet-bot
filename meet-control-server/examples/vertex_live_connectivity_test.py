#!/usr/bin/env python3
"""Small connectivity test for Gemini Live on Vertex AI.

Usage:
  pip install --upgrade google-genai
  python meet-control-server/examples/vertex_live_connectivity_test.py

Authentication:
  1. API key for Vertex AI Express Mode:
     set VERTEX_API_KEY=YOUR_API_KEY
     Note: Gemini Live 2.5 native audio models are regional on Vertex AI and
     generally require ADC instead of Express Mode API key auth.

  2. Application Default Credentials:
     gcloud auth application-default login
     set GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID

Optional environment variables:
  set GOOGLE_CLOUD_LOCATION=us-central1
  set GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
  set GEMINI_LIVE_PROMPT=Hola, confirma en espanol que la conectividad Live funciona.
  set GEMINI_LIVE_TIMEOUT_SEC=20
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
from typing import Iterable

from google import genai
from google.genai import types


DEFAULT_LOCATION = "us-central1"
DEFAULT_MODEL = "gemini-live-2.5-flash-native-audio"
DEFAULT_PROMPT = "Hola, confirma en espanol que la conectividad Live funciona."
DEFAULT_TIMEOUT_SEC = 20.0
NATIVE_AUDIO_REGIONAL_MODELS = {
    "gemini-live-2.5-flash-native-audio",
    "gemini-live-2.5-flash-preview-native-audio-09-2025",
}


def env_first(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


@contextlib.contextmanager
def temporary_env_unset(*names: str):
    saved: dict[str, str] = {}
    for name in names:
        value = os.environ.pop(name, None)
        if value is not None:
            saved[name] = value

    try:
        yield
    finally:
        for name, value in saved.items():
            os.environ[name] = value


def build_client() -> genai.Client:
    api_key = env_first("VERTEX_API_KEY", "GOOGLE_API_KEY")
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    location = os.getenv("GOOGLE_CLOUD_LOCATION", DEFAULT_LOCATION)
    http_options = types.HttpOptions(api_version="v1beta1")

    if api_key:
        print("Using Vertex AI API key authentication.")
        if project or os.getenv("GOOGLE_CLOUD_LOCATION"):
            print(
                "Ignoring GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION because "
                "Express Mode API key auth must not initialize project/location."
            )

        with temporary_env_unset("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"):
            return genai.Client(
                vertexai=True,
                api_key=api_key,
                http_options=http_options,
            )

    if not project:
        raise SystemExit(
            "Missing authentication. Set VERTEX_API_KEY for Express Mode or "
            "authenticate with ADC and set GOOGLE_CLOUD_PROJECT."
        )

    print(f"Using ADC authentication for project={project} location={location}.")
    return genai.Client(
        vertexai=True,
        project=project,
        location=location,
        http_options=http_options,
    )


def iter_parts_text(parts: Iterable[object] | None) -> list[str]:
    texts: list[str] = []
    if not parts:
        return texts

    for part in parts:
        text = getattr(part, "text", None)
        if text:
            texts.append(text)

    return texts


async def run_connectivity_test() -> int:
    model = os.getenv("GEMINI_LIVE_MODEL", DEFAULT_MODEL)
    prompt = os.getenv("GEMINI_LIVE_PROMPT", DEFAULT_PROMPT)
    timeout_sec = float(os.getenv("GEMINI_LIVE_TIMEOUT_SEC", DEFAULT_TIMEOUT_SEC))
    api_key = env_first("VERTEX_API_KEY", "GOOGLE_API_KEY")

    if api_key and model in NATIVE_AUDIO_REGIONAL_MODELS:
        raise SystemExit(
            "This model usually fails with a Vertex AI Express Mode API key. "
            "Use ADC plus GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION for "
            f"{model}, because Gemini Live 2.5 native audio is regional on Vertex AI."
        )

    client = build_client()

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        output_audio_transcription={},
    )

    print(f"Connecting to model={model} ...")

    async with client.aio.live.connect(model=model, config=config) as session:
        print(f"> {prompt}")
        await session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=prompt)]),
            turn_complete=True,
        )

        audio_chunks = 0
        audio_bytes = 0
        transcript_fragments: list[str] = []
        receiver = session.receive()

        while True:
            try:
                message = await asyncio.wait_for(
                    receiver.__anext__(),
                    timeout=timeout_sec,
                )
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError as exc:
                raise SystemExit(
                    f"Timed out after {timeout_sec:.0f}s while waiting for the Live response."
                ) from exc

            server_content = getattr(message, "server_content", None)
            if not server_content:
                continue

            model_turn = getattr(server_content, "model_turn", None)
            if model_turn and getattr(model_turn, "parts", None):
                for text in iter_parts_text(model_turn.parts):
                    transcript_fragments.append(text)
                    print(f"[text] {text}")

                for part in model_turn.parts:
                    inline_data = getattr(part, "inline_data", None)
                    data = getattr(inline_data, "data", None) if inline_data else None
                    if data:
                        audio_chunks += 1
                        audio_bytes += len(data)

            if getattr(server_content, "turn_complete", False):
                break

    transcript = "".join(transcript_fragments).strip()

    print("")
    print("Connectivity test passed.")
    print(f"Audio chunks received: {audio_chunks}")
    print(f"Audio bytes received: {audio_bytes}")
    if transcript:
        print(f"Transcript: {transcript}")
    else:
        print("Transcript: <none>")

    return 0


def main() -> int:
    try:
        return asyncio.run(run_connectivity_test())
    except KeyboardInterrupt:
        print("\nInterrupted by user.")
        return 130
    except Exception as exc:  # pragma: no cover - convenience for local testing
        print(f"Connectivity test failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
