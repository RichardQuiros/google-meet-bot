"""Low-latency Gemini Live voice session over RTP."""

from __future__ import annotations

import asyncio
from array import array
from collections import deque
import logging
import math
import os
from typing import Awaitable, Callable, Optional

from google import genai
from google.genai import types

from app.meetmind_agent.prompts import build_realtime_voice_prompt
from app.meetmind_agent.roles import ParticipationMode, RoleConfig
from bridge.command_sender import CommandSender
from bridge.sse_consumer import MediaTransportEvent
from services.rtp_audio import AsyncRtpAudioReceiver, AsyncRtpAudioSender
from services.realtime_debug import RealtimeDebugRecorder

logger = logging.getLogger(__name__)

OnRealtimeResponse = Callable[[str], Awaitable[None]]
OnRealtimeTranscript = Callable[[str], Awaitable[None]]


class RealtimeVoiceSession:
    """Streams meeting audio to Gemini Live and returns model audio via RTP."""

    def __init__(
        self,
        role: RoleConfig,
        command_sender: Optional[CommandSender] = None,
        on_response: Optional[OnRealtimeResponse] = None,
        on_input_transcript: Optional[OnRealtimeTranscript] = None,
        debug_session_label: Optional[str] = None,
    ):
        self.role = role
        self.command_sender = command_sender
        self.on_response = on_response
        self.on_input_transcript = on_input_transcript
        self.model = os.getenv("GEMINI_REALTIME_MODEL") or os.getenv(
            "GEMINI_LIVE_MODEL",
            "gemini-live-2.5-flash-native-audio",
        )
        self.voice_name = os.getenv("GEMINI_REALTIME_VOICE") or role.voice_name or "Aoede"
        self.greeting_enabled = os.getenv("GEMINI_REALTIME_GREETING", "true").lower() not in {
            "0",
            "false",
            "no",
        }
        self.transcript_fallback_enabled = os.getenv(
            "REALTIME_TRANSCRIPT_FALLBACK",
            "true",
        ).lower() not in {"0", "false", "no"}
        self.transcript_fallback_cooldown_s = float(
            os.getenv("REALTIME_TRANSCRIPT_FALLBACK_COOLDOWN_S", "6")
        )
        self.transcript_fallback_after_live_s = float(
            os.getenv("REALTIME_TRANSCRIPT_FALLBACK_AFTER_LIVE_S", "2.5")
        )
        self.input_suppress_ms = int(os.getenv("REALTIME_AUDIO_SUPPRESS_MS", "900"))
        self.input_chunk_ms = int(os.getenv("REALTIME_AUDIO_INPUT_CHUNK_MS", "40"))
        self.vad_prefix_ms = int(os.getenv("REALTIME_VAD_PREFIX_MS", "80"))
        self.vad_silence_ms = int(os.getenv("REALTIME_VAD_SILENCE_MS", "220"))
        self.max_output_tokens = int(os.getenv("REALTIME_MAX_OUTPUT_TOKENS", "80"))
        self.context_window_items = max(
            4,
            int(os.getenv("REALTIME_CONTEXT_WINDOW_ITEMS", "8")),
        )
        self.context_item_max_chars = max(
            120,
            int(os.getenv("REALTIME_CONTEXT_ITEM_MAX_CHARS", "220")),
        )
        self.output_idle_end_ms = int(os.getenv("REALTIME_OUTPUT_IDLE_END_MS", "700"))
        self.output_playback_chunk_ms = int(
            os.getenv("REALTIME_OUTPUT_PLAYBACK_CHUNK_MS", "20")
        )
        self.output_delivery_mode = (
            os.getenv("REALTIME_OUTPUT_DELIVERY_MODE", "hybrid").strip().lower() or "hybrid"
        )
        self.force_tts_mirror = os.getenv(
            "REALTIME_FORCE_TTS_MIRROR",
            "false",
        ).lower() not in {"0", "false", "no"}
        self.output_keepalive_ms = int(
            os.getenv("REALTIME_OUTPUT_KEEPALIVE_MS", "1000")
        )
        self.output_keepalive_chunk_ms = int(
            os.getenv("REALTIME_OUTPUT_KEEPALIVE_CHUNK_MS", "20")
        )
        self.audio_stream_end_on_activity_end = os.getenv(
            "REALTIME_SEND_AUDIO_STREAM_END",
            "false",
        ).lower() not in {"0", "false", "no"}
        self.local_silence_rms = int(os.getenv("REALTIME_AUDIO_SILENCE_RMS", "160"))
        self.local_stream_end_ms = int(os.getenv("REALTIME_AUDIO_STREAM_END_MS", "700"))
        self.manual_activity_detection = os.getenv(
            "REALTIME_MANUAL_ACTIVITY_DETECTION",
            "true",
        ).lower() not in {"0", "false", "no"}
        self.ignore_server_interruptions = os.getenv(
            "REALTIME_IGNORE_SERVER_INTERRUPTION",
            "true",
        ).lower() not in {"0", "false", "no"}
        self.speech_start_rms = int(
            os.getenv("REALTIME_SPEECH_START_RMS", str(max(self.local_silence_rms * 4, 700)))
        )
        self.speech_end_rms = int(
            os.getenv("REALTIME_SPEECH_END_RMS", str(max(self.local_silence_rms * 2, 350)))
        )
        self.speech_end_ms = int(os.getenv("REALTIME_SPEECH_END_MS", "480"))
        self.max_turn_ms = int(os.getenv("REALTIME_MAX_TURN_MS", "10000"))
        self.reconnect_delay_ms = int(os.getenv("REALTIME_WS_RECONNECT_MS", "1500"))
        self.ws_ping_interval_s = float(os.getenv("REALTIME_WS_PING_INTERVAL_S", "30"))
        self.ws_ping_timeout_s = float(os.getenv("REALTIME_WS_PING_TIMEOUT_S", "60"))
        self.ws_open_timeout_s = float(os.getenv("REALTIME_WS_OPEN_TIMEOUT_S", "20"))
        self.ws_close_timeout_s = float(os.getenv("REALTIME_WS_CLOSE_TIMEOUT_S", "10"))
        self.ws_max_queue = int(os.getenv("REALTIME_WS_MAX_QUEUE", "64"))
        self.ws_write_limit = int(os.getenv("REALTIME_WS_WRITE_LIMIT", "262144"))
        self.session_resumption_enabled = os.getenv(
            "REALTIME_SESSION_RESUMPTION",
            "false",
        ).lower() in {"1", "true", "yes"}
        activity_handling_value = (
            os.getenv("REALTIME_ACTIVITY_HANDLING", "no_interruption").strip().lower()
        )
        self.activity_handling = (
            types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
            if activity_handling_value in {"interrupt", "interrupts", "start_of_activity_interrupts"}
            else types.ActivityHandling.NO_INTERRUPTION
        )
        turn_coverage_value = (
            os.getenv("REALTIME_TURN_COVERAGE", "all_input").strip().lower()
        )
        self.turn_coverage = (
            types.TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY
            if turn_coverage_value in {"activity", "only_activity", "turn_includes_only_activity"}
            else types.TurnCoverage.TURN_INCLUDES_ALL_INPUT
        )
        self._project = os.getenv("GOOGLE_CLOUD_PROJECT")
        self._location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._playback_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._output_idle_task: Optional[asyncio.Task] = None
        self._audio_sender: Optional[AsyncRtpAudioSender] = None
        self._audio_receiver: Optional[AsyncRtpAudioReceiver] = None
        self._audio_sender_lock = asyncio.Lock()
        self._text_queue: asyncio.Queue[str] = asyncio.Queue()
        self._output_audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue()
        self._suppress_input_until = 0.0
        self._greeting_sent = False
        self._last_input_text = ""
        self._last_output_text = ""
        self._last_live_input_transcript_at = 0.0
        self._last_transcript_fallback_text = ""
        self._last_transcript_fallback_at = 0.0
        self._session_handle: Optional[str] = None
        self._logged_first_input_transcript = False
        self._logged_first_active_input_audio = False
        self._logged_first_output_audio = False
        self._logged_first_output_transcript = False
        self._pending_output_text = ""
        self._pending_input_text = ""
        self._last_emitted_output_text = ""
        self._last_output_activity_at = 0.0
        self._playback_send_deadline: Optional[float] = None
        self._last_rtp_output_at = 0.0
        self._pending_output_had_audio = False
        self._logged_first_rtp_output_write = False
        self._input_stream_active = False
        self._recent_context: deque[tuple[str, str]] = deque(maxlen=self.context_window_items)
        self._preferred_response_language: Optional[str] = None
        self._latest_visual_context = ""
        self._debug = RealtimeDebugRecorder(
            debug_session_label or f"{role.role_id}-realtime"
        )
        self._rtp_output_enabled = self.output_delivery_mode in {"rtp", "hybrid", "both"}
        self._tts_output_enabled = self.output_delivery_mode in {"tts", "hybrid", "both"}

        self.responses_generated = 0
        self.input_transcriptions = 0
        self.input_audio_chunks = 0
        self.active_input_audio_chunks = 0
        self.output_audio_chunks = 0
        self.interruptions = 0
        self.activity_starts = 0
        self.activity_ends = 0
        self.reconnects = 0
        self.keepalive_timeouts = 0
        self.silence_dropped_chunks = 0

    async def start(self, transport: MediaTransportEvent):
        """Start the realtime audio loop once RTP transport is ready."""
        if self.role.mode == ParticipationMode.OBSERVER:
            logger.info("Realtime voice session skipped for observer role=%s", self.role.role_name)
            return
        if self._running:
            return
        if not transport.audio_input or not transport.meeting_audio_output:
            logger.warning(
                "Realtime voice transport unavailable: audio_input=%s meeting_audio_output=%s",
                bool(transport.audio_input),
                bool(transport.meeting_audio_output),
            )
            return
        if not self._project:
            raise RuntimeError("GOOGLE_CLOUD_PROJECT is required for realtime Gemini Live audio")

        self._audio_sender = AsyncRtpAudioSender(transport.audio_input)
        self._audio_receiver = AsyncRtpAudioReceiver(
            transport.meeting_audio_output,
            chunk_duration_ms=self.input_chunk_ms,
        )
        await self._audio_sender.start()
        await self._audio_receiver.start()
        self._debug.start(
            {
                "model": self.model,
                "role_id": self.role.role_id,
                "role_name": self.role.role_name,
                "voice_name": self.voice_name,
                "manual_activity_detection": self.manual_activity_detection,
                "speech_start_rms": self.speech_start_rms,
                "speech_end_rms": self.speech_end_rms,
                "speech_end_ms": self.speech_end_ms,
                "max_turn_ms": self.max_turn_ms,
                "output_idle_end_ms": self.output_idle_end_ms,
                "output_playback_chunk_ms": self.output_playback_chunk_ms,
                "output_delivery_mode": self.output_delivery_mode,
                "force_tts_mirror": self.force_tts_mirror,
                "transcript_fallback_enabled": self.transcript_fallback_enabled,
                "audio_stream_end_on_activity_end": (
                    self.audio_stream_end_on_activity_end
                    and not self.manual_activity_detection
                ),
                "session_resumption_enabled": self.session_resumption_enabled,
                "activity_handling": str(self.activity_handling),
                "turn_coverage": str(self.turn_coverage),
                "ignore_server_interruptions": self.ignore_server_interruptions,
                "meeting_audio": {
                    "host": transport.meeting_audio_output.host,
                    "port": transport.meeting_audio_output.port,
                    "sample_rate": transport.meeting_audio_output.sample_rate,
                    "channels": transport.meeting_audio_output.channels,
                },
                "bot_audio": {
                    "host": transport.audio_input.host,
                    "port": transport.audio_input.port,
                    "sample_rate": transport.audio_input.sample_rate,
                    "channels": transport.audio_input.channels,
                },
            }
        )
        if self._debug.get_session_dir():
            logger.info("Realtime voice debug output: %s", self._debug.get_session_dir())

        self._running = True
        self._task = asyncio.create_task(self._run())
        self._playback_task = asyncio.create_task(self._play_output_loop())
        if self._rtp_output_enabled and self._audio_sender:
            self._keepalive_task = asyncio.create_task(self._send_output_keepalive_loop())
        logger.info(
            "Realtime voice session starting: model=%s voice=%s meeting_audio=%s:%s bot_audio=%s:%s",
            self.model,
            self.voice_name,
            transport.meeting_audio_output.host if transport.meeting_audio_output else "",
            transport.meeting_audio_output.port if transport.meeting_audio_output else 0,
            transport.audio_input.host if transport.audio_input else "",
            transport.audio_input.port if transport.audio_input else 0,
        )

    async def stop(self):
        """Stop the realtime voice session."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._cancel_playback_task()
        await self._cancel_keepalive_task()
        self._cancel_output_idle_timer()

        await self._close_audio()
        logger.info(
            "Realtime voice session stopped. Inputs=%s Outputs=%s Responses=%s",
            self.input_audio_chunks,
            self.output_audio_chunks,
            self.responses_generated,
        )
        self._debug.close()

    def get_stats(self) -> dict:
        return {
            "model": self.model,
            "voice_name": self.voice_name,
            "manual_activity_detection": self.manual_activity_detection,
            "session_resumption_enabled": self.session_resumption_enabled,
            "output_delivery_mode": self.output_delivery_mode,
            "force_tts_mirror": self.force_tts_mirror,
            "transcript_fallback_enabled": self.transcript_fallback_enabled,
            "activity_handling": str(self.activity_handling),
            "turn_coverage": str(self.turn_coverage),
            "ignore_server_interruptions": self.ignore_server_interruptions,
            "responses_generated": self.responses_generated,
            "input_transcriptions": self.input_transcriptions,
            "input_audio_chunks": self.input_audio_chunks,
            "active_input_audio_chunks": self.active_input_audio_chunks,
            "output_audio_chunks": self.output_audio_chunks,
            "interruptions": self.interruptions,
            "activity_starts": self.activity_starts,
            "activity_ends": self.activity_ends,
            "reconnects": self.reconnects,
            "keepalive_timeouts": self.keepalive_timeouts,
            "silence_dropped_chunks": self.silence_dropped_chunks,
            "queued_text_messages": self._text_queue.qsize(),
            "queued_output_audio_chunks": self._output_audio_queue.qsize(),
            "debug_dir": self._debug.get_session_dir(),
            "is_active": self._running,
        }

    async def send_text(self, text: str, *, source: str = "dashboard"):
        """Queue a text turn to the realtime voice model."""
        text = text.strip()
        if not text:
            return
        if source == "meeting-transcript":
            if not self.transcript_fallback_enabled:
                return
            loop = asyncio.get_running_loop()
            now = loop.time()
            if self._input_stream_active or self._pending_input_text:
                return
            normalized = " ".join(text.lower().split())
            if not normalized:
                return
            last_output_normalized = " ".join(self._last_output_text.lower().split())
            if (
                last_output_normalized
                and (
                    normalized == last_output_normalized
                    or normalized.endswith(last_output_normalized)
                    or last_output_normalized in normalized
                )
            ):
                return
            if (
                self._last_live_input_transcript_at
                and now - self._last_live_input_transcript_at < self.transcript_fallback_after_live_s
            ):
                return
            if (
                normalized == self._last_transcript_fallback_text
                and now - self._last_transcript_fallback_at < self.transcript_fallback_cooldown_s
            ):
                return
            self._last_transcript_fallback_text = normalized
            self._last_transcript_fallback_at = now
        await self._text_queue.put(f"{source}\n{text}")

    async def _run(self):
        client = genai.Client(
            vertexai=True,
            project=self._project,
            location=self._location,
            http_options=types.HttpOptions(
                async_client_args={
                    "compression": None,
                    "open_timeout": self.ws_open_timeout_s,
                    "ping_interval": self.ws_ping_interval_s,
                    "ping_timeout": self.ws_ping_timeout_s,
                    "close_timeout": self.ws_close_timeout_s,
                    "max_queue": self.ws_max_queue,
                    "write_limit": self.ws_write_limit,
                    "max_size": None,
                }
            ),
        )

        try:
            while self._running:
                try:
                    config = self._build_live_config()
                    async with client.aio.live.connect(model=self.model, config=config) as session:
                        logger.info("Realtime voice live session connected")
                        self._debug.event("live_session_connected")

                        receive_task = asyncio.create_task(
                            self._receive_loop(session),
                            name="realtime-receive",
                        )
                        send_task = asyncio.create_task(
                            self._send_audio_loop(session),
                            name="realtime-send-audio",
                        )
                        text_task = asyncio.create_task(
                            self._send_text_loop(session),
                            name="realtime-send-text",
                        )

                        if self.greeting_enabled and not self._greeting_sent:
                            await self.send_text(
                                "You just joined the meeting. Say one short greeting now, "
                                "then continue listening.",
                                source="system",
                            )
                            self._greeting_sent = True

                        await self._wait_for_session_tasks(
                            {receive_task, send_task, text_task}
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    if not self._running:
                        break

                    if "keepalive ping timeout" in str(error).lower():
                        self.keepalive_timeouts += 1

                    self.reconnects += 1
                    await self._finalize_output_turn(reason="reconnect")
                    self._debug.event(
                        "live_session_reconnect",
                        error=str(error),
                        reconnect_delay_ms=self.reconnect_delay_ms,
                        queued_output_audio_chunks=self._output_audio_queue.qsize(),
                    )
                    logger.warning(
                        "Realtime voice stream disconnected, reconnecting in %sms: %s (queued_output_audio_chunks=%s)",
                        self.reconnect_delay_ms,
                        error,
                        self._output_audio_queue.qsize(),
                    )
                    await asyncio.sleep(self.reconnect_delay_ms / 1000)
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self._debug.event("live_session_error", error=str(error))
            logger.error("Realtime voice session error: %s", error, exc_info=True)
        finally:
            await self._close_audio()

    async def _wait_for_session_tasks(self, tasks: set[asyncio.Task]) -> None:
        done, pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )

        error: Optional[BaseException] = None
        ended_tasks: list[str] = []
        for task in done:
            task_name = task.get_name() or "unnamed-task"
            ended_tasks.append(task_name)
            try:
                task.result()
            except asyncio.CancelledError:
                continue
            except BaseException as task_error:
                error = task_error
                break

        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        if error is not None:
            raise error

        if self._running:
            ended = ", ".join(sorted(ended_tasks)) or "unknown-task"
            raise RuntimeError(
                f"Realtime Gemini session ended unexpectedly (completed: {ended})"
            )

    def _build_live_config(self) -> types.LiveConnectConfig:
        config: dict[str, object] = {
            "response_modalities": [types.Modality.AUDIO],
            "max_output_tokens": self.max_output_tokens,
            "system_instruction": self._build_live_system_instruction(),
            "speech_config": types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice_name
                    )
                )
            ),
            "input_audio_transcription": types.AudioTranscriptionConfig(),
            "output_audio_transcription": types.AudioTranscriptionConfig(),
            "realtime_input_config": types.RealtimeInputConfig(
                activity_handling=self.activity_handling,
                turn_coverage=self.turn_coverage,
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=self.manual_activity_detection,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                    prefix_padding_ms=self.vad_prefix_ms,
                    silence_duration_ms=self.vad_silence_ms,
                ),
            ),
        }
        if self.session_resumption_enabled:
            config["session_resumption"] = types.SessionResumptionConfig(
                handle=self._session_handle,
                transparent=True,
            )

        return types.LiveConnectConfig(
            **config,
        )

    def _build_live_system_instruction(self) -> str:
        base_instruction = build_realtime_voice_prompt(self.role)
        continuity_lines: list[str] = []

        if self._preferred_response_language:
            continuity_lines.append(
                f"- Current meeting language: {self._preferred_response_language}. "
                f"Reply in {self._preferred_response_language} unless a participant clearly changes languages."
            )
        if self._last_input_text:
            continuity_lines.append(
                f"- Latest confirmed participant message: {self._trim_context_text(self._last_input_text)}"
            )
        if self._last_output_text:
            continuity_lines.append(
                f"- Latest confirmed MeetMind reply: {self._trim_context_text(self._last_output_text)}"
            )
        if self._recent_context:
            continuity_lines.append("Recent confirmed meeting context:")
            continuity_lines.extend(
                f"- {speaker}: {text}" for speaker, text in self._recent_context
            )
        if self._latest_visual_context:
            continuity_lines.append(
                f"- Latest trusted screen summary: {self._trim_context_text(self._latest_visual_context)}"
            )

        if not continuity_lines:
            return base_instruction

        return (
            f"{base_instruction}\n\n"
            "== LIVE CONTINUITY ==\n"
            "Use this trusted context to preserve topic, language, and recent decisions across reconnects.\n"
            "Do not quote it verbatim unless it is directly relevant to the conversation.\n"
            + "\n".join(continuity_lines)
        )

    def _remember_context(self, speaker: str, text: str) -> None:
        normalized = self._trim_context_text(text)
        if not normalized:
            return
        if self._recent_context and self._recent_context[-1] == (speaker, normalized):
            return
        self._recent_context.append((speaker, normalized))
        if speaker == "Participant":
            language_hint = self._detect_language_hint(normalized)
            if language_hint:
                self._preferred_response_language = language_hint

    def _trim_context_text(self, text: str) -> str:
        normalized = " ".join(text.split()).strip()
        if not normalized:
            return ""
        if len(normalized) <= self.context_item_max_chars:
            return normalized
        return normalized[: self.context_item_max_chars - 3].rstrip() + "..."

    def _detect_language_hint(self, text: str) -> Optional[str]:
        lowered = f" {text.lower()} "
        spanish_score = sum(
            marker in lowered
            for marker in (
                " el ",
                " la ",
                " los ",
                " las ",
                " un ",
                " una ",
                " que ",
                " para ",
                " con ",
                " como ",
                " pero ",
                " vamos ",
                " juego ",
                " idea ",
                " escenario ",
                " mecánica ",
                " dime ",
                " sobre ",
            )
        )
        english_score = sum(
            marker in lowered
            for marker in (
                " the ",
                " what ",
                " think ",
                " about ",
                " game ",
                " idea ",
                " scenario ",
                " could ",
                " should ",
                " would ",
                " let's ",
                " we ",
                " you ",
            )
        )

        if any(ch in lowered for ch in "áéíóúñ¿¡"):
            spanish_score += 2

        if spanish_score >= max(2, english_score + 1):
            return "Spanish"
        if english_score >= max(2, spanish_score + 1):
            return "English"
        return None

    def update_visual_context(self, summary: str) -> None:
        normalized = self._trim_context_text(summary)
        if not normalized or normalized == self._latest_visual_context:
            return
        self._latest_visual_context = normalized
        self._remember_context("Screen", normalized)

    async def _send_audio_loop(self, session):
        if not self._audio_receiver:
            return

        loop = asyncio.get_running_loop()
        sample_rate = self._audio_receiver.transport.sample_rate
        channels = self._audio_receiver.transport.channels
        bytes_per_second = sample_rate * channels * 2
        send_deadline: Optional[float] = None
        silence_ms = 0.0
        stream_is_open = False
        speech_ms = 0.0
        prefix_chunks: deque[bytes] = deque()
        prefix_duration_ms = 0.0

        async for chunk in self._audio_receiver.iter_chunks():
            if not self._running:
                break
            if loop.time() < self._suppress_input_until:
                if self.manual_activity_detection and stream_is_open:
                    await self._end_manual_activity(
                        session,
                        reason="suppressed",
                        duration_ms=speech_ms,
                    )
                elif stream_is_open:
                    await self._end_auto_input_stream(
                        session,
                        reason="suppressed",
                        silence_ms=silence_ms,
                    )
                send_deadline = loop.time()
                silence_ms = 0.0
                speech_ms = 0.0
                stream_is_open = False
                self._input_stream_active = False
                prefix_chunks.clear()
                prefix_duration_ms = 0.0
                continue

            chunk_duration_ms = (len(chunk) / bytes_per_second) * 1000
            rms = self._chunk_rms(chunk)
            is_silence = rms < self.local_silence_rms

            if self.manual_activity_detection:
                if not stream_is_open:
                    prefix_chunks.append(chunk)
                    prefix_duration_ms += chunk_duration_ms
                    while prefix_duration_ms > self.vad_prefix_ms and prefix_chunks:
                        dropped = prefix_chunks.popleft()
                        prefix_duration_ms -= (len(dropped) / bytes_per_second) * 1000

                    if rms < self.speech_start_rms:
                        self.silence_dropped_chunks += 1
                        continue

                    await session.send_realtime_input(activity_start=types.ActivityStart())
                    self.activity_starts += 1
                    stream_is_open = True
                    self._input_stream_active = True
                    silence_ms = 0.0
                    speech_ms = 0.0
                    self._pending_input_text = ""
                    self._debug.start_input_turn(
                        sample_rate=sample_rate,
                        channels=channels,
                        rms=rms,
                        buffered_ms=prefix_duration_ms,
                    )
                    self._debug.event(
                        "activity_start_sent",
                        rms=round(rms, 2),
                        buffered_ms=round(prefix_duration_ms, 1),
                    )
                    logger.info(
                        "Realtime voice local activity start: rms=%s buffered_ms=%s",
                        round(rms, 2),
                        round(prefix_duration_ms, 1),
                    )

                    buffered_chunks = list(prefix_chunks)
                    prefix_chunks.clear()
                    prefix_duration_ms = 0.0

                    for buffered_chunk in buffered_chunks:
                        buffered_duration_ms = (len(buffered_chunk) / bytes_per_second) * 1000
                        send_deadline = await self._send_audio_chunk(
                            session,
                            buffered_chunk,
                            sample_rate=sample_rate,
                            bytes_per_second=bytes_per_second,
                            send_deadline=send_deadline,
                        )
                        speech_ms += buffered_duration_ms
                    continue

                send_deadline = await self._send_audio_chunk(
                    session,
                    chunk,
                    sample_rate=sample_rate,
                    bytes_per_second=bytes_per_second,
                    send_deadline=send_deadline,
                )
                speech_ms += chunk_duration_ms
                self.active_input_audio_chunks += 1
                if not self._logged_first_active_input_audio:
                    logger.info(
                        "Realtime voice received first active meeting audio chunk: rms=%s bytes=%s",
                        round(rms, 2),
                        len(chunk),
                    )
                    self._logged_first_active_input_audio = True

                if rms < self.speech_end_rms:
                    silence_ms += chunk_duration_ms
                else:
                    silence_ms = 0.0

                if silence_ms >= self.speech_end_ms or speech_ms >= self.max_turn_ms:
                    reason = "silence" if silence_ms >= self.speech_end_ms else "max_turn"
                    await self._end_manual_activity(
                        session,
                        reason=reason,
                        duration_ms=speech_ms,
                        silence_ms=silence_ms,
                    )
                    stream_is_open = False
                    self._input_stream_active = False
                    silence_ms = 0.0
                    speech_ms = 0.0
                    send_deadline = None
                continue

            if not stream_is_open and is_silence:
                self.silence_dropped_chunks += 1
                continue

            if is_silence:
                silence_ms += chunk_duration_ms
                if silence_ms >= self.local_stream_end_ms:
                    await self._end_auto_input_stream(
                        session,
                        reason="silence",
                        silence_ms=silence_ms,
                    )
                    stream_is_open = False
                    self._input_stream_active = False
                    silence_ms = 0.0
                    send_deadline = None
                    self.silence_dropped_chunks += 1
                    continue
            else:
                silence_ms = 0.0
                if not stream_is_open:
                    self._pending_input_text = ""
                    self._input_stream_active = True
                    self._debug.start_input_turn(
                        sample_rate=sample_rate,
                        channels=channels,
                        rms=rms,
                        buffered_ms=0.0,
                    )
                    self._debug.event(
                        "auto_input_stream_started",
                        rms=round(rms, 2),
                    )
                stream_is_open = True
                self.active_input_audio_chunks += 1
                if not self._logged_first_active_input_audio:
                    logger.info(
                        "Realtime voice received first active meeting audio chunk: rms=%s bytes=%s",
                        round(rms, 2),
                        len(chunk),
                    )
                    self._logged_first_active_input_audio = True

            send_deadline = await self._send_audio_chunk(
                session,
                chunk,
                sample_rate=sample_rate,
                bytes_per_second=bytes_per_second,
                send_deadline=send_deadline,
            )

        if self.manual_activity_detection and stream_is_open:
            await self._end_manual_activity(
                session,
                reason="stream_closed",
                duration_ms=speech_ms,
                silence_ms=silence_ms,
            )
        elif stream_is_open:
            await self._end_auto_input_stream(
                session,
                reason="stream_closed",
                silence_ms=silence_ms,
            )
        self._input_stream_active = False

    async def _send_audio_chunk(
        self,
        session,
        chunk: bytes,
        *,
        sample_rate: int,
        bytes_per_second: int,
        send_deadline: Optional[float],
    ) -> Optional[float]:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if send_deadline is None or now - send_deadline > 0.2:
            send_deadline = now
        elif now < send_deadline:
            await asyncio.sleep(send_deadline - now)

        self.input_audio_chunks += 1
        self._debug.append_input_audio(chunk)
        await session.send_realtime_input(
            audio=types.Blob(
                data=chunk,
                mime_type=f"audio/pcm;rate={sample_rate}",
            )
        )
        return send_deadline + (len(chunk) / bytes_per_second)

    async def _end_manual_activity(
        self,
        session,
        *,
        reason: str,
        duration_ms: float,
        silence_ms: float = 0.0,
    ) -> None:
        await session.send_realtime_input(activity_end=types.ActivityEnd())
        # Keep the live session open across turns when we are using manual activity
        # boundaries, otherwise the server treats each turn like a completed stream.
        send_audio_stream_end = False
        if send_audio_stream_end:
            await session.send_realtime_input(audio_stream_end=True)
        self.activity_ends += 1
        self._debug.event(
            "activity_end_sent",
            reason=reason,
            duration_ms=round(duration_ms, 1),
            silence_ms=round(silence_ms, 1),
            audio_stream_end=send_audio_stream_end,
        )
        self._input_stream_active = False
        self._debug.finish_input_turn(
            reason=reason,
            transcript=self._pending_input_text or None,
        )
        logger.info(
            "Realtime voice local activity end: reason=%s duration_ms=%s silence_ms=%s",
            reason,
            round(duration_ms, 1),
            round(silence_ms, 1),
        )

    async def _end_auto_input_stream(
        self,
        session,
        *,
        reason: str,
        silence_ms: float = 0.0,
    ) -> None:
        await session.send_realtime_input(audio_stream_end=True)
        self._debug.event(
            "audio_stream_end_sent",
            reason=reason,
            silence_ms=round(silence_ms, 1),
        )
        self._input_stream_active = False
        self._debug.finish_input_turn(
            reason=reason,
            transcript=self._pending_input_text or None,
        )
        logger.info(
            "Realtime voice auto input stream ended: reason=%s silence_ms=%s",
            reason,
            round(silence_ms, 1),
        )

    async def _receive_loop(self, session):
        async for message in session.receive():
            if not self._running:
                break

            session_resumption_update = getattr(message, "session_resumption_update", None)
            if (
                self.session_resumption_enabled
                and session_resumption_update
                and getattr(session_resumption_update, "new_handle", None)
            ):
                self._session_handle = session_resumption_update.new_handle
                self._debug.event(
                    "session_resumption_handle",
                    handle=self._session_handle,
                )

            server_content = getattr(message, "server_content", None)
            if not server_content:
                continue

            turn_complete = bool(getattr(server_content, "turn_complete", False))
            generation_complete = bool(getattr(server_content, "generation_complete", False))
            turn_complete_reason = getattr(server_content, "turn_complete_reason", None)
            voice_activity = getattr(server_content, "voice_activity", None)
            voice_activity_type = getattr(voice_activity, "voice_activity_type", None)
            if voice_activity_type:
                self._debug.event(
                    "server_voice_activity",
                    voice_activity_type=str(voice_activity_type),
                )

            if getattr(server_content, "interrupted", False):
                self.interruptions += 1
                self._debug.event("server_interrupted")
                if self.ignore_server_interruptions:
                    logger.info("Realtime voice ignoring server interruption event")
                else:
                    await self._handle_interruption()

            input_transcription = getattr(server_content, "input_transcription", None)
            if input_transcription:
                text = (getattr(input_transcription, "text", "") or "").strip()
                finished = bool(getattr(input_transcription, "finished", False))
                if text:
                    self._debug.event(
                        "input_transcription",
                        text=text,
                        finished=finished,
                    )
                    self._pending_input_text = self._merge_transcript_text(
                        self._pending_input_text,
                        text,
                    )
                if (
                    self._pending_input_text
                    and finished
                    and self._pending_input_text != self._last_input_text
                ):
                    self._last_input_text = self._pending_input_text
                    self._remember_context("Participant", self._pending_input_text)
                    self._last_live_input_transcript_at = asyncio.get_running_loop().time()
                    self.input_transcriptions += 1
                    if not self._logged_first_input_transcript:
                        logger.info(
                            "Realtime voice received input transcription: %s",
                            self._pending_input_text[:160],
                        )
                        self._logged_first_input_transcript = True
                    await self._emit_input_transcript(self._pending_input_text)

            transcription = getattr(server_content, "output_transcription", None)
            if transcription:
                text = (getattr(transcription, "text", "") or "").strip()
                finished = bool(getattr(transcription, "finished", False))
                if text:
                    self._debug.event(
                        "output_transcription",
                        text=text,
                        finished=finished,
                    )
                    self._pending_output_text = self._merge_transcript_text(
                        self._pending_output_text,
                        text,
                    )
                    self._mark_output_activity()
                    if not self._logged_first_output_transcript:
                        logger.info(
                            "Realtime voice received output transcription: %s",
                            self._pending_output_text[:160],
                        )
                        self._logged_first_output_transcript = True
                    self._schedule_output_idle_timer()
                if finished:
                    await self._finalize_output_turn(reason="output_transcription_finished")

            model_turn = getattr(server_content, "model_turn", None)
            if not model_turn or not getattr(model_turn, "parts", None):
                if generation_complete:
                    self._debug.event(
                        "server_generation_complete",
                        pending_output_text=self._pending_output_text or None,
                    )
                    await self._finalize_output_turn(reason="generation_complete")
                if turn_complete:
                    self._debug.event(
                        "server_turn_complete",
                        pending_output_text=self._pending_output_text or None,
                        pending_input_text=self._pending_input_text or None,
                        turn_complete_reason=str(turn_complete_reason) if turn_complete_reason else None,
                    )
                    await self._finalize_output_turn(reason="turn_complete")
                    self._pending_input_text = ""
                continue

            for part in model_turn.parts:
                inline_data = getattr(part, "inline_data", None)
                if (
                    inline_data
                    and inline_data.data
                    and inline_data.mime_type
                    and inline_data.mime_type.startswith("audio/")
                ):
                    self.output_audio_chunks += 1
                    if not self._logged_first_output_audio:
                        logger.info(
                            "Realtime voice received first audio chunk: mime=%s bytes=%s",
                            inline_data.mime_type,
                            len(inline_data.data),
                        )
                        self._logged_first_output_audio = True
                    if self._rtp_output_enabled and self._audio_sender:
                        self._debug.append_output_audio(
                            inline_data.data,
                            sample_rate=self._audio_sender.transport.sample_rate,
                            channels=self._audio_sender.transport.channels,
                        )
                    if self._rtp_output_enabled:
                        self._pending_output_had_audio = True
                        self._mark_output_activity()
                        await self._queue_output_audio(inline_data.data)

            if generation_complete:
                self._debug.event(
                    "server_generation_complete",
                    pending_output_text=self._pending_output_text or None,
                )
                await self._finalize_output_turn(reason="generation_complete")
            elif turn_complete:
                self._debug.event(
                    "server_turn_complete",
                    pending_output_text=self._pending_output_text or None,
                    pending_input_text=self._pending_input_text or None,
                    turn_complete_reason=str(turn_complete_reason) if turn_complete_reason else None,
                )
                await self._finalize_output_turn(reason="turn_complete")
                self._pending_input_text = ""

    async def _queue_output_audio(self, chunk: bytes) -> None:
        if not chunk or not self._running:
            return
        await self._output_audio_queue.put(chunk)
        self._schedule_output_idle_timer()

    async def _play_output_loop(self) -> None:
        loop = asyncio.get_running_loop()

        while self._running:
            chunk = await self._output_audio_queue.get()
            if chunk is None:
                break
            if not self._rtp_output_enabled or not self._audio_sender:
                continue

            bytes_per_second = (
                self._audio_sender.transport.sample_rate
                * self._audio_sender.transport.channels
                * 2
            )
            chunk_bytes = max(
                self._audio_sender.transport.channels * 2,
                int(bytes_per_second * (max(self.output_playback_chunk_ms, 10) / 1000)),
            )

            for start in range(0, len(chunk), chunk_bytes):
                frame = chunk[start : start + chunk_bytes]
                if not frame or not self._running:
                    break

                now = loop.time()
                if self._playback_send_deadline is None or now - self._playback_send_deadline > 0.2:
                    self._playback_send_deadline = now
                elif now < self._playback_send_deadline:
                    await asyncio.sleep(self._playback_send_deadline - now)

                self._suppress_input_until = max(
                    self._suppress_input_until,
                    loop.time() + (self.input_suppress_ms / 1000),
                )
                await self._write_output_pcm(frame)
                if not self._logged_first_rtp_output_write:
                    logger.info(
                        "Realtime voice wrote first RTP output chunk: bytes=%s",
                        len(frame),
                    )
                    self._logged_first_rtp_output_write = True
                self._playback_send_deadline += len(frame) / bytes_per_second

    async def _send_output_keepalive_loop(self) -> None:
        if not self._audio_sender or self.output_keepalive_ms <= 0:
            return

        bytes_per_second = (
            self._audio_sender.transport.sample_rate
            * self._audio_sender.transport.channels
            * 2
        )
        keepalive_size = max(
            self._audio_sender.transport.channels * 2,
            int(
                bytes_per_second
                * (max(self.output_keepalive_chunk_ms, 10) / 1000)
            ),
        )
        silence = b"\x00" * keepalive_size
        loop = asyncio.get_running_loop()
        self._last_rtp_output_at = loop.time()

        while self._running and self._rtp_output_enabled and self._audio_sender:
            await asyncio.sleep(self.output_keepalive_ms / 1000)
            if not self._running or not self._audio_sender:
                break
            if self._output_audio_queue.qsize() > 0:
                continue

            now = loop.time()
            if now - self._last_rtp_output_at < (self.output_keepalive_ms / 1000):
                continue

            await self._write_output_pcm(silence)

    async def _write_output_pcm(self, chunk: bytes) -> None:
        if not self._audio_sender or not chunk:
            return

        async with self._audio_sender_lock:
            await self._audio_sender.write_pcm(chunk)
            self._last_rtp_output_at = asyncio.get_running_loop().time()

    def _mark_output_activity(self) -> None:
        self._last_output_activity_at = asyncio.get_running_loop().time()

    def _schedule_output_idle_timer(self) -> None:
        if not self._running:
            return
        self._cancel_output_idle_timer()
        self._output_idle_task = asyncio.create_task(self._flush_output_when_idle())

    def _cancel_output_idle_timer(self) -> None:
        if self._output_idle_task:
            current = asyncio.current_task()
            if self._output_idle_task is not current:
                self._output_idle_task.cancel()
            self._output_idle_task = None

    async def _cancel_keepalive_task(self) -> None:
        if self._keepalive_task:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except asyncio.CancelledError:
                pass
            self._keepalive_task = None

    async def _flush_output_when_idle(self) -> None:
        started_at = self._last_output_activity_at
        try:
            await asyncio.sleep(self.output_idle_end_ms / 1000)
        except asyncio.CancelledError:
            return

        if not self._running:
            return
        if started_at != self._last_output_activity_at:
            return
        await self._finalize_output_turn(reason="idle_timeout")

    async def _finalize_output_turn(self, *, reason: str) -> None:
        self._cancel_output_idle_timer()
        final_text = self._pending_output_text.strip()
        if final_text and final_text != self._last_emitted_output_text:
            self._last_output_text = final_text
            self._last_emitted_output_text = final_text
            self._remember_context("MeetMind", final_text)
            self.responses_generated += 1
            await self._emit_response(final_text)
            await self._deliver_response_text(
                final_text,
                used_model_audio=self._pending_output_had_audio,
            )
        self._debug.finish_output_turn(
            reason=reason,
            transcription=final_text or None,
        )
        self._pending_output_text = ""
        self._pending_output_had_audio = False

    def _merge_transcript_text(self, current: str, piece: str) -> str:
        piece = piece.strip()
        if not piece:
            return current
        if not current:
            return piece
        if piece == current or current.endswith(piece):
            return current
        if piece.startswith(current):
            return piece
        separator = "" if piece[0] in ",.!?;:" or current.endswith(("'", "-", "/")) else " "
        return f"{current}{separator}{piece}"

    async def _send_text_loop(self, session):
        while self._running:
            payload = await self._text_queue.get()
            source, text = payload.split("\n", 1)
            try:
                await self._send_live_text(session, text, source=source)
            except asyncio.CancelledError:
                await self._requeue_text_payload(payload)
                raise
            except Exception as error:
                if self._should_requeue_text_payload(error):
                    await self._requeue_text_payload(payload)
                raise

    async def _send_live_text(self, session, text: str, *, source: str):
        logger.info("Realtime voice sending %s text turn: %s", source, text[:120])
        if source == "dashboard":
            prompt_text = f"[dashboard] {text}"
            self._remember_context("Dashboard", text)
        elif source == "meet-chat":
            prompt_text = f"[meet-chat] {text}"
            self._remember_context("Meet chat", text)
        elif source == "meeting-transcript":
            prompt_text = f"[meeting-transcript] {text}"
        else:
            prompt_text = text
        self._debug.event(
            "text_turn_sent",
            source=source,
            text=prompt_text,
        )
        await session.send_realtime_input(
            text=prompt_text,
        )

    async def _requeue_text_payload(self, payload: str) -> None:
        if not self._running:
            return
        await self._text_queue.put(payload)

    def _should_requeue_text_payload(self, error: Exception) -> bool:
        message = str(error).lower()
        error_name = error.__class__.__name__.lower()
        return any(
            marker in message or marker in error_name
            for marker in (
                "connectionclosed",
                "keepalive ping timeout",
                "timed out while closing connection",
                "no close frame received",
            )
        )

    async def _emit_input_transcript(self, text: str):
        if not self.on_input_transcript:
            return

        try:
            await self.on_input_transcript(text)
        except Exception as error:
            logger.error("Realtime input transcription error: %s", error, exc_info=True)

    async def _emit_response(self, text: str):
        if not self.on_response:
            return

        try:
            await self.on_response(text)
        except Exception as error:
            logger.error("Realtime voice broadcast error: %s", error, exc_info=True)

    async def _deliver_response_text(self, text: str, *, used_model_audio: bool) -> None:
        should_use_tts = self.output_delivery_mode in {"tts", "both"} or (
            self.output_delivery_mode == "hybrid"
            and (self.force_tts_mirror or not used_model_audio)
        )
        if not should_use_tts or not self.command_sender:
            return

        spoken_text = text if len(text) <= 200 else text[:180].rstrip() + "..."
        result = await self.command_sender.speak(spoken_text)
        self._debug.event(
            "tts_delivery",
            success=result.success,
            text=spoken_text,
            fallback=used_model_audio is False,
            mirrored=self.force_tts_mirror and self.output_delivery_mode in {"hybrid", "both"},
            error=result.error,
        )
        if not result.success:
            logger.warning("Realtime TTS delivery failed: %s", result.error)

    async def _handle_interruption(self):
        self._suppress_input_until = 0.0
        await self._finalize_output_turn(reason="interruption_reset")
        await self._drain_output_audio_queue()
        self._pending_output_had_audio = False
        if not self._audio_sender:
            return

        try:
            await self._audio_sender.reset()
        except Exception as error:
            logger.warning("Realtime audio sender reset failed after interruption: %s", error)

    def _chunk_rms(self, chunk: bytes) -> float:
        sample_count = len(chunk) // 2
        if sample_count <= 0:
            return 0.0

        samples = array("h")
        samples.frombytes(chunk[: sample_count * 2])
        if not samples:
            return 0.0

        energy = sum(sample * sample for sample in samples)
        return math.sqrt(energy / len(samples))

    async def _drain_output_audio_queue(self) -> None:
        while True:
            try:
                item = self._output_audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is None:
                await self._output_audio_queue.put(None)
                break
        self._playback_send_deadline = None

    async def _cancel_playback_task(self) -> None:
        self._cancel_output_idle_timer()
        await self._drain_output_audio_queue()
        if self._playback_task:
            await self._output_audio_queue.put(None)
            self._playback_task.cancel()
            try:
                await self._playback_task
            except asyncio.CancelledError:
                pass
            self._playback_task = None

    async def _close_audio(self):
        self._cancel_output_idle_timer()
        self._input_stream_active = False
        self._debug.finish_input_turn(
            reason="audio_closed",
            transcript=self._pending_input_text or None,
        )
        await self._finalize_output_turn(reason="audio_closed")
        self._pending_input_text = ""
        self._pending_output_text = ""
        if self._audio_receiver:
            await self._audio_receiver.close()
            self._audio_receiver = None
        if self._audio_sender:
            await self._audio_sender.close()
            self._audio_sender = None
