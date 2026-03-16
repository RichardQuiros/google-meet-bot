"""Persistent debug traces for the realtime voice pipeline."""

from __future__ import annotations

import json
import os
import re
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_label(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return cleaned or "realtime-session"


class RealtimeDebugRecorder:
    """Writes request/response traces and audio artifacts for a live session."""

    def __init__(self, session_label: str):
        self.enabled = os.getenv("REALTIME_DEBUG", "true").lower() not in {
            "0",
            "false",
            "no",
        }
        self.base_dir = Path(os.getenv("REALTIME_DEBUG_DIR", "/tmp/meetmind-debug"))
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.session_dir = self.base_dir / f"{timestamp}_{_safe_label(session_label)}"
        self.events_path = self.session_dir / "events.jsonl"
        self.meta_path = self.session_dir / "session.json"
        self._started = False
        self._input_turn_index = 0
        self._output_turn_index = 0
        self._current_input_audio = bytearray()
        self._current_output_audio = bytearray()
        self._current_input_meta: Optional[dict[str, Any]] = None
        self._current_output_meta: Optional[dict[str, Any]] = None

    def start(self, metadata: dict[str, Any]) -> None:
        if not self.enabled or self._started:
            return

        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(
            json.dumps(metadata, ensure_ascii=True, indent=2, default=str),
            encoding="utf-8",
        )
        self._started = True
        self.event("session_started", **metadata)

    def close(self) -> None:
        if not self.enabled or not self._started:
            return

        self.finish_input_turn(reason="session_closed")
        self.finish_output_turn(reason="session_closed")
        self.event("session_closed")

    def event(self, event_type: str, **data: Any) -> None:
        if not self.enabled or not self._started:
            return

        payload = {
            "ts": _utc_now(),
            "event": event_type,
            **data,
        }
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True, default=str))
            handle.write("\n")

    def start_input_turn(
        self,
        *,
        sample_rate: int,
        channels: int,
        rms: float,
        buffered_ms: float,
    ) -> int:
        if not self.enabled or not self._started:
            return 0

        self.finish_input_turn(reason="replaced")
        self._input_turn_index += 1
        self._current_input_audio = bytearray()
        self._current_input_meta = {
            "turn_index": self._input_turn_index,
            "sample_rate": sample_rate,
            "channels": channels,
            "started_at": _utc_now(),
        }
        self.event(
            "input_turn_started",
            turn_index=self._input_turn_index,
            rms=round(rms, 2),
            buffered_ms=round(buffered_ms, 1),
        )
        return self._input_turn_index

    def append_input_audio(self, chunk: bytes) -> None:
        if not self.enabled or not self._current_input_meta:
            return
        self._current_input_audio.extend(chunk)

    def finish_input_turn(self, *, reason: str, transcript: Optional[str] = None) -> Optional[str]:
        if not self.enabled or not self._current_input_meta:
            return None

        meta = self._current_input_meta
        wav_path = self.session_dir / f"input-turn-{meta['turn_index']:03d}.wav"
        self._write_wav(
            wav_path,
            bytes(self._current_input_audio),
            sample_rate=meta["sample_rate"],
            channels=meta["channels"],
        )
        duration_ms = (
            (len(self._current_input_audio) / (meta["sample_rate"] * meta["channels"] * 2)) * 1000
            if self._current_input_audio
            else 0.0
        )
        self.event(
            "input_turn_finished",
            turn_index=meta["turn_index"],
            reason=reason,
            bytes=len(self._current_input_audio),
            duration_ms=round(duration_ms, 1),
            transcript=transcript,
            wav_path=str(wav_path),
        )
        self._current_input_audio = bytearray()
        self._current_input_meta = None
        return str(wav_path)

    def append_output_audio(
        self,
        chunk: bytes,
        *,
        sample_rate: int,
        channels: int,
    ) -> int:
        if not self.enabled or not self._started:
            return 0

        if not self._current_output_meta:
            self._output_turn_index += 1
            self._current_output_meta = {
                "turn_index": self._output_turn_index,
                "sample_rate": sample_rate,
                "channels": channels,
                "started_at": _utc_now(),
            }
            self._current_output_audio = bytearray()
            self.event("output_turn_started", turn_index=self._output_turn_index)

        self._current_output_audio.extend(chunk)
        return self._current_output_meta["turn_index"]

    def finish_output_turn(
        self,
        *,
        reason: str,
        transcription: Optional[str] = None,
    ) -> Optional[str]:
        if not self.enabled or not self._current_output_meta:
            return None

        meta = self._current_output_meta
        wav_path = self.session_dir / f"output-turn-{meta['turn_index']:03d}.wav"
        self._write_wav(
            wav_path,
            bytes(self._current_output_audio),
            sample_rate=meta["sample_rate"],
            channels=meta["channels"],
        )
        duration_ms = (
            (len(self._current_output_audio) / (meta["sample_rate"] * meta["channels"] * 2)) * 1000
            if self._current_output_audio
            else 0.0
        )
        self.event(
            "output_turn_finished",
            turn_index=meta["turn_index"],
            reason=reason,
            bytes=len(self._current_output_audio),
            duration_ms=round(duration_ms, 1),
            transcription=transcription,
            wav_path=str(wav_path),
        )
        self._current_output_audio = bytearray()
        self._current_output_meta = None
        return str(wav_path)

    def get_session_dir(self) -> Optional[str]:
        if not self.enabled:
            return None
        return str(self.session_dir)

    def _write_wav(
        self,
        path: Path,
        pcm_data: bytes,
        *,
        sample_rate: int,
        channels: int,
    ) -> None:
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(channels)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm_data)
