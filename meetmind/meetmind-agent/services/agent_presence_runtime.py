"""Conversation-first runtime that makes the live voice agent the primary actor."""

from __future__ import annotations

import logging
import os
from dataclasses import replace
from typing import Awaitable, Callable, Optional

from app.meetmind_agent.roles import ParticipationMode, RoleConfig
from bridge.command_sender import CommandSender
from bridge.frame_fetcher import FrameFetcher
from bridge.sse_consumer import (
    BotStatusEvent,
    MediaTransportEvent,
    SSEConsumer,
    TextEvent,
    VideoFrameEvent,
)
from gemini.live_session import GeminiLiveSession
from services.realtime_voice_session import RealtimeVoiceSession

logger = logging.getLogger(__name__)

DashboardPublisher = Callable[[dict], Awaitable[None]]


class AgentPresenceRuntime:
    """Owns the live agent, the notes observer, and all event routing."""

    def __init__(
        self,
        *,
        role: RoleConfig,
        control_base_url: str,
        meeting_id: str,
        bot_id: str,
        publish_dashboard_event: DashboardPublisher,
        on_agent_response: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        self.role = role
        self.control_base_url = control_base_url.rstrip("/")
        self.meeting_id = meeting_id
        self.bot_id = bot_id
        self.publish_dashboard_event = publish_dashboard_event
        self.on_agent_response = on_agent_response
        self.voice_enabled = os.getenv("ENABLE_REALTIME_VOICE", "true").lower() not in {
            "0",
            "false",
            "no",
        } and role.mode != ParticipationMode.OBSERVER
        self.ignore_sse_audio_transcripts = self.voice_enabled and (
            os.getenv("REALTIME_IGNORE_SSE_AUDIO_TRANSCRIPTS", "true").lower()
            not in {"0", "false", "no"}
        )
        self.notes_role = (
            replace(role, mode=ParticipationMode.OBSERVER)
            if self.voice_enabled
            else role
        )

        self.command_sender = CommandSender(
            control_base_url=self.control_base_url,
            bot_id=self.bot_id,
            meeting_id=self.meeting_id,
        )
        self.frame_fetcher = FrameFetcher(
            control_base_url=self.control_base_url,
            meeting_id=self.meeting_id,
        )
        self.notes_session = GeminiLiveSession(
            role=self.notes_role,
            command_sender=self.command_sender,
            session_id=f"meetmind_{role.role_id}_{meeting_id}",
            on_response=on_agent_response,
            on_screen_summary=self._handle_screen_summary,
        )
        self.voice_session: Optional[RealtimeVoiceSession] = None
        if self.voice_enabled:
            self.voice_session = RealtimeVoiceSession(
                role=self.role,
                command_sender=self.command_sender,
                on_response=on_agent_response,
                on_input_transcript=self._handle_realtime_input_transcript,
                debug_session_label=f"{meeting_id}_{role.role_id}",
            )

        self.sse_consumer = SSEConsumer(
            control_base_url=self.control_base_url,
            meeting_id=self.meeting_id,
        )
        self.sse_consumer.on_text(self._handle_text_event).on_frame(
            self._handle_frame_event
        ).on_status(self._handle_status_event).on_media_transport(
            self._handle_media_transport
        )

        self.bot_status = "created"
        self.meeting_url: Optional[str] = None
        self.display_name: Optional[str] = None
        self.is_active = False
        self.latest_screen_summary = ""

    async def start(self, *, meeting_url: str, display_name: str) -> None:
        """Start the runtime and request the bot to join the meeting."""
        self.meeting_url = meeting_url
        self.display_name = display_name

        await self.command_sender.start()
        await self.frame_fetcher.start()
        await self.notes_session.start()

        try:
            join_result = await self.command_sender.join(
                meeting_url=meeting_url,
                display_name=display_name,
                camera=False,
                microphone=True,
            )
            if not join_result.success:
                raise RuntimeError(
                    "Failed to queue bot join command. "
                    f"Control server response: {join_result.error or 'unknown error'}"
                )

            self.is_active = True
            self.bot_status = "joining"
            await self.sse_consumer.start()
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        """Stop the runtime and release all resources."""
        self.is_active = False
        await self.sse_consumer.stop()
        if self.voice_session:
            await self.voice_session.stop()
        await self.notes_session.stop()
        await self.frame_fetcher.stop()
        await self.command_sender.stop()

    async def send_dashboard_message(self, text: str) -> None:
        """Send a dashboard instruction to the live agent and the note session."""
        text = text.strip()
        if not text:
            return

        await self.notes_session.handle_dashboard_message(text)
        if self.voice_session:
            await self.voice_session.send_text(text)

        await self.publish_dashboard_event(
            {
                "type": "transcript",
                "kind": "dashboard",
                "speaker": "Dashboard",
                "text": text,
                "is_agent": False,
            }
        )

    def get_stats(self) -> dict:
        """Return a combined view of the live runtime state."""
        stats = self.notes_session.get_stats()
        if self.voice_session:
            stats["realtime_voice"] = self.voice_session.get_stats()
        stats["voice_enabled"] = self.voice_enabled
        stats["ignore_sse_audio_transcripts"] = self.ignore_sse_audio_transcripts
        stats["bot_status"] = self.bot_status
        return stats

    async def _handle_text_event(self, event: TextEvent) -> None:
        voice = self.voice_session
        text = event.text.strip()
        audio_transcript_is_informational = (
            event.kind == "audioTranscript" and self.ignore_sse_audio_transcripts
        )
        informational_unknown_speaker = (
            audio_transcript_is_informational
            and event.speaker.strip().lower() in {"unknown", "unknown speaker"}
        )

        if voice and event.kind == "audioTranscript" and text and not audio_transcript_is_informational:
            await voice.send_text(
                f"{event.speaker} said in the meeting: {text}",
                source="meeting-transcript",
            )

        if voice and event.kind == "chat" and text:
            await voice.send_text(
                f"{event.speaker} wrote in Meet chat: {text}",
                source="meet-chat",
            )

        if not audio_transcript_is_informational:
            await self.notes_session.handle_text_event(event)
        if informational_unknown_speaker:
            return
        await self.publish_dashboard_event(
            {
                "type": "transcript",
                "kind": event.kind,
                "speaker": event.speaker,
                "text": event.text,
                "is_agent": False,
                "informational_only": audio_transcript_is_informational,
                "ignored_by_agent": audio_transcript_is_informational,
            }
        )

    async def _handle_frame_event(self, event: VideoFrameEvent) -> None:
        jpeg_data = await self.frame_fetcher.fetch_frame(event.frame_url)
        if not jpeg_data:
            return

        await self.notes_session.handle_video_frame(jpeg_data)
        await self.publish_dashboard_event(
            {
                "type": "frame_received",
                "frame_id": event.frame_id,
            }
        )

    async def _handle_screen_summary(self, summary: str) -> None:
        self.latest_screen_summary = summary
        if self.voice_session:
            self.voice_session.update_visual_context(summary)
        await self.publish_dashboard_event(
            {
                "type": "transcript",
                "kind": "vision",
                "speaker": "Screen",
                "text": summary,
                "is_agent": False,
                "informational_only": True,
                "ignored_by_agent": False,
            }
        )

    async def _handle_status_event(self, event: BotStatusEvent) -> None:
        self.bot_status = event.status
        await self.publish_dashboard_event(
            {
                "type": "bot_status",
                "status": event.status,
                "error": event.error,
            }
        )

    async def _handle_media_transport(self, event: MediaTransportEvent) -> None:
        if self.voice_session:
            await self.voice_session.start(event)

    async def _handle_realtime_input_transcript(self, text: str) -> None:
        event = TextEvent(
            kind="audioRealtime",
            text=text,
            speaker="Participant",
            occurred_at="",
            raw={"source": "gemini-live"},
        )
        await self.notes_session.handle_text_event(event)
        await self.publish_dashboard_event(
            {
                "type": "transcript",
                "kind": event.kind,
                "speaker": event.speaker,
                "text": event.text,
                "is_agent": False,
            }
        )
