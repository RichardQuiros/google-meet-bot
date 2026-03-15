"""
MeetMind Gemini Live Session — Vertex AI Mode
Manages a Gemini Live API session via ADK using Vertex AI backend.

Requires:
  - GOOGLE_CLOUD_PROJECT: Your GCP project ID
  - GOOGLE_CLOUD_LOCATION: Region (e.g. us-central1)
  - GOOGLE_GENAI_USE_VERTEXAI=true
  - Application Default Credentials (gcloud auth)
"""

import asyncio
import os
import logging
from typing import Optional

from google.adk.agents import Agent
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.meetmind_agent.roles import RoleConfig
from app.meetmind_agent.prompts import build_system_prompt
from app.meetmind_agent.tools import take_note, flag_action_item
from bridge.command_sender import CommandSender

logger = logging.getLogger(__name__)

# Vertex AI model names for Live API
# gemini-live-2.5-flash-native-audio  — native audio (GA)
# gemini-2.5-flash                     — text mode via Live API
LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash")


class GeminiLiveSession:
    """
    Manages a bidirectional streaming session with Gemini Live API
    via Vertex AI backend.
    """
    
    def __init__(
        self,
        role: RoleConfig,
        command_sender: CommandSender,
        session_id: str = "meetmind_session",
    ):
        self.role = role
        self.command_sender = command_sender
        self.session_id = session_id
        self._live_queue: Optional[LiveRequestQueue] = None
        self._runner: Optional[Runner] = None
        self._agent: Optional[Agent] = None
        self._session_service: Optional[InMemorySessionService] = None
        self._run_task: Optional[asyncio.Task] = None
        self._is_active = False
        
        # Stats
        self.text_inputs = 0
        self.frame_inputs = 0
        self.responses_generated = 0
    
    async def start(self):
        """Initialize the Gemini Live API session via Vertex AI."""
        # Log the configuration
        project = os.getenv("GOOGLE_CLOUD_PROJECT", "not-set")
        location = os.getenv("GOOGLE_CLOUD_LOCATION", "not-set")
        use_vertex = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "not-set")
        logger.info(
            f"Vertex AI config: project={project}, location={location}, "
            f"use_vertexai={use_vertex}, model={LIVE_MODEL}"
        )
        
        # Build the agent with role-specific prompt
        instruction = build_system_prompt(self.role)
        
        self._agent = Agent(
            name="meetmind_agent",
            model=LIVE_MODEL,
            description=f"MeetMind AI - Role: {self.role.role_name}",
            instruction=instruction,
            tools=[
                take_note,
                flag_action_item,
            ],
        )
        
        # Phase 1: Initialize services
        self._session_service = InMemorySessionService()
        self._runner = Runner(
            agent=self._agent,
            app_name="meetmind",
            session_service=self._session_service,
        )
        
        # Create a session for this meeting
        await self._session_service.create_session(
            app_name="meetmind",
            user_id="meetmind_user",
            session_id=self.session_id,
        )
        
        # Phase 2: Create LiveRequestQueue and RunConfig
        self._live_queue = LiveRequestQueue()
        
        # Detect model type for correct config
        is_native_audio = "native-audio" in LIVE_MODEL
        
        if is_native_audio:
            run_config = RunConfig(
                streaming_mode=StreamingMode.BIDI,
                response_modalities=["AUDIO"],
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                session_resumption=types.SessionResumptionConfig(),
            )
        else:
            # Text mode — use TEXT modality
            run_config = RunConfig(
                streaming_mode=StreamingMode.BIDI,
                response_modalities=["TEXT"],
                session_resumption=types.SessionResumptionConfig(),
            )
        
        # Phase 3: Start the live streaming loop in background
        self._is_active = True
        self._run_task = asyncio.create_task(
            self._process_responses(run_config)
        )
        
        logger.info(
            f"Gemini session started: model={LIVE_MODEL}, "
            f"role={self.role.role_name}, mode={self.role.mode.value}, "
            f"native_audio={is_native_audio}, vertex_ai=true"
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
            f"Gemini session stopped. Texts: {self.text_inputs}, "
            f"Frames: {self.frame_inputs}, Responses: {self.responses_generated}"
        )
    
    async def handle_text_event(self, event):
        """Process a text event from the meeting."""
        if not self._live_queue or not self._is_active:
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
        
        self._live_queue.send_realtime(
            types.Blob(
                data=jpeg_data,
                mime_type="image/jpeg",
            )
        )
        self.frame_inputs += 1
    
    async def handle_dashboard_message(self, text: str):
        """Process a text message from the dashboard."""
        if not self._live_queue or not self._is_active:
            return
        
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[types.Part(text=f"[dashboard instruction] {text}")],
            )
        )
    
    async def _process_responses(self, run_config: RunConfig):
        """Main loop — processes Gemini's responses via runner.run_live()."""
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
        except Exception as e:
            logger.error(f"Gemini response processing error: {e}", exc_info=True)
    
    async def _handle_agent_event(self, event):
        """Handle a single event from the Gemini agent."""
        try:
            if not hasattr(event, 'content') or not event.content:
                return
            if not event.content.parts:
                return
            
            for part in event.content.parts:
                if hasattr(part, 'text') and part.text:
                    text = part.text.strip()
                    if not text:
                        continue
                    
                    self.responses_generated += 1
                    logger.info(f"Agent response [{self.role.role_name}]: {text[:100]}...")
                    await self._dispatch_response(text)
                
                if hasattr(part, 'inline_data') and part.inline_data:
                    if part.inline_data.mime_type and part.inline_data.mime_type.startswith("audio/"):
                        logger.debug(f"Received audio chunk: {len(part.inline_data.data)} bytes")
        
        except Exception as e:
            logger.error(f"Error handling agent event: {e}", exc_info=True)
    
    async def _dispatch_response(self, text: str):
        """Route agent response to meeting (speak or chat)."""
        from app.meetmind_agent.roles import ParticipationMode
        
        if self.role.mode == ParticipationMode.OBSERVER:
            logger.info(f"[Observer] Noted: {text[:100]}...")
            return
        
        if len(text) <= 200:
            await self.command_sender.speak(text)
        else:
            summary = text[:180] + "..."
            await self.command_sender.speak(summary)
            await asyncio.sleep(0.5)
            await self.command_sender.chat(text)
    
    def get_stats(self) -> dict:
        """Return session statistics."""
        return {
            "session_id": self.session_id,
            "role": self.role.role_name,
            "mode": self.role.mode.value,
            "model": LIVE_MODEL,
            "is_active": self._is_active,
            "text_inputs": self.text_inputs,
            "frame_inputs": self.frame_inputs,
            "responses_generated": self.responses_generated,
        }
