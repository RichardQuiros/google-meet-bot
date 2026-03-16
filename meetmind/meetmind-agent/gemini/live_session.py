"""
MeetMind Gemini Live Session - Vertex AI mode.

Manages a Gemini Live API session via ADK using the Vertex AI backend.

Requires:
  - GOOGLE_CLOUD_PROJECT: Your GCP project ID
  - GOOGLE_CLOUD_LOCATION: Region (for example, us-central1)
  - GOOGLE_GENAI_USE_VERTEXAI=true
  - Application Default Credentials
"""

import asyncio
import hashlib
import logging
import os
from typing import Awaitable, Callable, Optional

from google.adk.agents import Agent
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.meetmind_agent.prompts import build_screen_vision_prompt, build_system_prompt
from app.meetmind_agent.roles import RoleConfig
from app.meetmind_agent.tools import flag_action_item, take_note
from bridge.command_sender import CommandSender

logger = logging.getLogger(__name__)

# Native audio is reserved for the dedicated voice session. This notes/vision
# session uses a text-capable Live model so it can summarize screen content and
# meeting events deterministically.
DEFAULT_LIVE_MODEL = "gemini-live-2.5-flash-native-audio"
CONFIGURED_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", DEFAULT_LIVE_MODEL)
DEFAULT_NOTES_LIVE_MODEL = "gemini-2.0-flash-live-preview-04-09"


class GeminiLiveSession:
    """
    Manages a bidirectional streaming session with Gemini Live API
    via the Vertex AI backend.
    """

    def __init__(
        self,
        role: RoleConfig,
        command_sender: CommandSender,
        session_id: str = "meetmind_session",
        on_response: Optional[Callable[[str], Awaitable[None]]] = None,
        on_screen_summary: Optional[Callable[[str], Awaitable[None]]] = None,
        vision_only: bool = False,
    ):
        self.role = role
        self.command_sender = command_sender
        self.session_id = session_id
        self._on_response = on_response
        self._on_screen_summary = on_screen_summary
        self._vision_only = vision_only
        self._live_queue: Optional[LiveRequestQueue] = None
        self._runner: Optional[Runner] = None
        self._agent: Optional[Agent] = None
        self._session_service: Optional[InMemorySessionService] = None
        self._run_task: Optional[asyncio.Task] = None
        self._is_active = False
        self._configured_model = CONFIGURED_LIVE_MODEL
        self._model_name = self._resolve_model_name()
        self._last_frame_digest: Optional[str] = None
        self._last_frame_summary_at = 0.0
        self._frame_summary_interval_s = float(
            os.getenv("VISION_FRAME_SUMMARY_INTERVAL_S", "2.0")
        )
        self.latest_screen_summary = ""
        self.latest_post_meeting_report = ""
        self._pending_post_meeting_report: Optional[asyncio.Future[str]] = None
        self._post_meeting_request_open = False

        # Stats
        self.text_inputs = 0
        self.frame_inputs = 0
        self.responses_generated = 0
        self.screen_summaries_generated = 0

    def _resolve_model_name(self) -> str:
        configured_notes_model = (os.getenv("GEMINI_NOTES_LIVE_MODEL", "") or "").strip()
        if configured_notes_model:
            return configured_notes_model

        if "native-audio" in self._configured_model:
            return DEFAULT_NOTES_LIVE_MODEL

        return self._configured_model

    async def start(self):
        """Initialize the Gemini Live API session via Vertex AI."""
        project = os.getenv("GOOGLE_CLOUD_PROJECT", "not-set")
        location = os.getenv("GOOGLE_CLOUD_LOCATION", "not-set")
        use_vertex = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "not-set")
        logger.info(
            "Vertex AI config: project=%s, location=%s, use_vertexai=%s, "
            "configured_model=%s, active_model=%s",
            project,
            location,
            use_vertex,
            self._configured_model,
            self._model_name,
        )

        instruction = (
            build_screen_vision_prompt(self.role)
            if self._vision_only
            else build_system_prompt(self.role)
        )
        self._agent = Agent(
            name="meetmind_screen_vision" if self._vision_only else "meetmind_agent",
            model=self._model_name,
            description=(
                f"MeetMind screen analyst - Focus: {self.role.vision_focus}"
                if self._vision_only
                else f"MeetMind AI - Role: {self.role.role_name}"
            ),
            instruction=instruction,
            tools=[] if self._vision_only else [take_note, flag_action_item],
        )

        self._session_service = InMemorySessionService()
        self._runner = Runner(
            agent=self._agent,
            app_name="meetmind",
            session_service=self._session_service,
        )

        await self._session_service.create_session(
            app_name="meetmind",
            user_id="meetmind_user",
            session_id=self.session_id,
        )

        self._live_queue = LiveRequestQueue()

        # This session powers notes, dashboard context, and visual reasoning.
        # Keep it text-only even when the underlying model supports native audio;
        # spoken output is handled separately by RealtimeVoiceSession.
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=[types.Modality.TEXT],
            session_resumption=types.SessionResumptionConfig(),
        )
        output_mode = "text"

        self._is_active = True
        self._run_task = asyncio.create_task(self._process_responses(run_config))

        logger.info(
            "Gemini session started: configured_model=%s, active_model=%s, "
            "role=%s, mode=%s, vertex_ai=true, output_mode=%s, vision_only=%s",
            self._configured_model,
            self._model_name,
            self.role.role_name,
            self.role.mode.value,
            output_mode,
            self._vision_only,
        )

    async def stop(self):
        """Stop the Gemini session."""
        self._is_active = False

        if self._live_queue:
            self._live_queue.close()

        if self._run_task:
            self._run_task.cancel()
            try:
                await self._run_task
            except asyncio.CancelledError:
                pass

        logger.info(
            "Gemini session stopped. Texts: %s, Frames: %s, Responses: %s",
            self.text_inputs,
            self.frame_inputs,
            self.responses_generated,
        )

    async def handle_text_event(self, event):
        """Process a text event from the meeting."""
        if not self._live_queue or not self._is_active:
            return
        if self._vision_only:
            return

        formatted = f"[{event.kind}] {event.speaker}: {event.text}"
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[types.Part(text=formatted)],
            )
        )
        self.text_inputs += 1

    async def handle_video_frame(self, jpeg_data: bytes):
        """Process a video frame from the meeting."""
        if not self._live_queue or not self._is_active:
            return

        if not self.role.vision_enabled:
            return

        digest = hashlib.sha1(jpeg_data).hexdigest()
        loop = asyncio.get_running_loop()
        now = loop.time()
        if digest == self._last_frame_digest:
            return
        if (
            self._last_frame_summary_at
            and now - self._last_frame_summary_at < self._frame_summary_interval_s
        ):
            return

        self._last_frame_digest = digest
        self._last_frame_summary_at = now
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[
                    types.Part(
                        text=self._build_frame_analysis_prompt()
                    ),
                    types.Part(
                        inline_data=types.Blob(
                            data=jpeg_data,
                            mime_type="image/jpeg",
                        )
                    ),
                ],
            )
        )
        self.frame_inputs += 1

    async def handle_dashboard_message(self, text: str):
        """Process a text message from the dashboard."""
        if not self._live_queue or not self._is_active:
            return
        if self._vision_only:
            return

        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[types.Part(text=f"[dashboard instruction] {text}")],
            )
        )

    async def request_post_meeting_report(self, timeout_s: float = 18.0) -> str:
        """Ask the session for a final post-meeting report and wait for it."""
        if not self._live_queue or not self._is_active:
            return self.latest_post_meeting_report
        if self._vision_only:
            return ""

        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        self._pending_post_meeting_report = future
        self._post_meeting_request_open = True
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[
                    types.Part(
                        text=(
                            "[meeting-ended] The meeting has ended. Produce the final post-meeting "
                            "report now. Return exactly one complete response prefixed with "
                            "[post-meeting-report]. Include the outcome, key decisions, unresolved "
                            "questions, action items with owners if known, and any meaningful screen "
                            "content that mattered."
                        )
                    )
                ],
            )
        )

        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        except asyncio.TimeoutError:
            logger.warning("Timed out waiting for post-meeting report")
            return self.latest_post_meeting_report
        finally:
            self._post_meeting_request_open = False
            if self._pending_post_meeting_report is future:
                self._pending_post_meeting_report = None

    async def _process_responses(self, run_config: RunConfig):
        """Main loop that processes Gemini responses via runner.run_live()."""
        try:
            async for event in self._runner.run_live(
                live_request_queue=self._live_queue,
                run_config=run_config,
                user_id="meetmind_user",
                session_id=self.session_id,
            ):
                if not self._is_active:
                    break

                await self._handle_agent_event(event)

        except asyncio.CancelledError:
            pass
        except Exception as error:
            logger.error(
                "Gemini response processing error: %s",
                error,
                exc_info=True,
            )

    async def _handle_agent_event(self, event):
        """Handle a single event from the Gemini agent."""
        try:
            transcription = getattr(event, "output_transcription", None)
            if transcription:
                text = (getattr(transcription, "text", "") or "").strip()
                if text and getattr(transcription, "finished", False):
                    if await self._handle_internal_post_meeting_report(text):
                        return
                    if await self._handle_internal_screen_summary(text):
                        return
                    self.responses_generated += 1
                    logger.info(
                        "Agent response [%s]: %s...",
                        self.role.role_name,
                        text[:100],
                    )
                    await self._dispatch_response(text)

            if not hasattr(event, "content") or not event.content:
                return
            if not event.content.parts:
                return
            if getattr(event, "partial", False):
                return

            for part in event.content.parts:
                if hasattr(part, "text") and part.text:
                    text = part.text.strip()
                    if not text:
                        continue

                    if await self._handle_internal_post_meeting_report(text):
                        continue
                    if await self._handle_internal_screen_summary(text):
                        continue
                    self.responses_generated += 1
                    logger.info(
                        "Agent response [%s]: %s...",
                        self.role.role_name,
                        text[:100],
                    )
                    await self._dispatch_response(text)

                if hasattr(part, "inline_data") and part.inline_data:
                    if (
                        part.inline_data.mime_type
                        and part.inline_data.mime_type.startswith("audio/")
                    ):
                        logger.debug(
                            "Received audio chunk from Gemini that is ignored by "
                            "the current TTS-based bridge: %s bytes",
                            len(part.inline_data.data),
                        )

        except Exception as error:
            logger.error("Error handling agent event: %s", error, exc_info=True)

    async def _handle_internal_screen_summary(self, text: str) -> bool:
        normalized = text.strip()
        marker = "[screen-summary]"
        if not normalized.lower().startswith(marker):
            return False

        summary = normalized[len(marker):].strip()
        if not summary:
            return True

        if summary == self.latest_screen_summary:
            return True

        self.latest_screen_summary = summary
        self.screen_summaries_generated += 1
        logger.info("Screen summary updated: %s", summary[:200])
        if self._on_screen_summary:
            try:
                await self._on_screen_summary(summary)
            except Exception as error:
                logger.error("Error broadcasting screen summary: %s", error, exc_info=True)
        return True

    async def _handle_internal_post_meeting_report(self, text: str) -> bool:
        normalized = text.strip()
        marker = "[post-meeting-report]"
        if not normalized.lower().startswith(marker):
            if not self._post_meeting_request_open or not normalized:
                return False
            return self._capture_post_meeting_report(normalized, fallback=True)

        report = normalized[len(marker):].strip()
        if not report:
            return True

        return self._capture_post_meeting_report(report, fallback=False)

    async def _dispatch_response(self, text: str):
        """Route agent response to meeting (speak or chat)."""
        from app.meetmind_agent.roles import ParticipationMode

        if self.role.mode == ParticipationMode.OBSERVER:
            logger.info("[Observer] Noted: %s...", text[:100])
            return

        spoken_text = text if len(text) <= 200 else text[:180] + "..."
        await self._emit_response(spoken_text)

        speak_result = await self.command_sender.speak(spoken_text)
        if not speak_result.success:
            logger.warning(
                "Speech delivery failed for role=%s, falling back to chat: %s",
                self.role.role_name,
                speak_result.error,
            )
            await self.command_sender.chat(text)
            return

        if len(text) <= 200:
            return
        else:
            await asyncio.sleep(0.5)
            await self.command_sender.chat(text)

    async def _emit_response(self, text: str):
        """Broadcast an agent response to the dashboard when available."""
        if not self._on_response:
            return

        try:
            await self._on_response(text)
        except Exception as error:
            logger.error("Error broadcasting agent response: %s", error, exc_info=True)

    def get_stats(self) -> dict:
        """Return session statistics."""
        return {
            "session_id": self.session_id,
            "role": self.role.role_name,
            "mode": self.role.mode.value,
            "configured_model": self._configured_model,
            "model": self._model_name,
            "is_active": self._is_active,
            "text_inputs": self.text_inputs,
            "frame_inputs": self.frame_inputs,
            "responses_generated": self.responses_generated,
            "screen_summaries_generated": self.screen_summaries_generated,
            "latest_screen_summary": self.latest_screen_summary or None,
            "latest_post_meeting_report": self.latest_post_meeting_report or None,
            "vision_only": self._vision_only,
        }

    def _build_frame_analysis_prompt(self) -> str:
        focus_instructions = {
            "general": "Prioritize the main shared artifact and any clearly visible text or UI state.",
            "code": "Prioritize the code editor, terminal output, file names, and only clearly legible code.",
            "slides": "Prioritize the active slide, title, headings, charts, and clearly legible bullets.",
            "documents": "Prioritize the document title, sections, and any clearly legible clauses or paragraphs.",
            "diagrams": "Prioritize the main diagram, labels, nodes, arrows, and any clearly legible annotations.",
        }
        return (
            "[screen-analysis] Analyze only the attached image and ignore prior meeting context. "
            "Do not infer anything from audio, chat, or earlier turns. "
            f"{focus_instructions.get(self.role.vision_focus, focus_instructions['general'])} "
            "First decide whether this frame contains meaningful shared screen content or is mostly the Google Meet interface, participant tiles, or an unclear scene. "
            "Only mention details that are directly visible. "
            "If text is too small, blurry, cropped, or obstructed, explicitly say it is unreadable instead of guessing. "
            "Return exactly one concise line prefixed with [screen-summary]. "
            "If there is no meaningful shared content, return exactly [screen-summary] No meaningful shared screen content."
        )

    def _capture_post_meeting_report(self, report: str, *, fallback: bool) -> bool:
        normalized_report = report.strip()
        if not normalized_report:
            return True

        self.latest_post_meeting_report = normalized_report
        pending = self._pending_post_meeting_report
        if pending and not pending.done():
            pending.set_result(normalized_report)
        if fallback:
            logger.info(
                "Post-meeting report captured without explicit marker: %s",
                normalized_report[:200],
            )
        else:
            logger.info("Post-meeting report generated: %s", normalized_report[:200])
        return True
