"""
MeetMind Gemini Live Session
Manages a Gemini Live API session via ADK that processes meeting events
and decides when/how to respond.

This is the brain of MeetMind — it receives text and vision from the meeting
(via the bridge layer) and produces responses that are sent back to the meeting
(via the command sender).
"""

import asyncio
import os
import logging
from typing import Optional

from google.adk.agents import Agent, LiveRequestQueue
from google.adk.runners import Runner
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.tools import google_search
from google.genai import types

from app.meetmind_agent.roles import RoleConfig
from app.meetmind_agent.prompts import build_system_prompt
from app.meetmind_agent.tools import take_note, flag_action_item
from bridge.sse_consumer import TextEvent, VideoFrameEvent
from bridge.command_sender import CommandSender

logger = logging.getLogger(__name__)

LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio")


class GeminiLiveSession:
    """
    Manages a bidirectional streaming session with Gemini Live API.
    
    Receives:
    - Text events (chat messages, captions, audio transcripts) → send_content()
    - JPEG video frames → send_realtime() as image blobs
    
    Produces:
    - Text responses → dispatched as speak or chat commands
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
        self._run_task: Optional[asyncio.Task] = None
        self._is_active = False
        
        # Stats
        self.text_inputs = 0
        self.frame_inputs = 0
        self.responses_generated = 0
    
    async def start(self):
        """Initialize the Gemini Live API session."""
        # Build the agent with role-specific prompt
        instruction = build_system_prompt(self.role)
        
        self._agent = Agent(
            name="meetmind_agent",
            model=LIVE_MODEL,
            description=f"MeetMind AI - Role: {self.role.role_name}",
            instruction=instruction,
            tools=[
                google_search,
                take_note,
                flag_action_item,
            ],
        )
        
        self._runner = Runner(
            agent=self._agent,
            app_name="meetmind",
        )
        
        # Create the LiveRequestQueue
        self._live_queue = LiveRequestQueue()
        
        # Build RunConfig
        run_config = RunConfig(
            response_modalities=["TEXT"],  # We get text decisions, then speak via TTS
            streaming_mode=StreamingMode.BIDI,
            session_resumption=True,
            context_window_compression=True,
        )
        
        # Start the live streaming loop in background
        self._is_active = True
        self._run_task = asyncio.create_task(
            self._process_responses(run_config)
        )
        
        logger.info(
            f"Gemini session started: model={LIVE_MODEL}, "
            f"role={self.role.role_name}, mode={self.role.mode.value}"
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
    
    async def handle_text_event(self, event: TextEvent):
        """
        Process a text event from the meeting.
        Sends it to Gemini as user content with speaker attribution.
        """
        if not self._live_queue or not self._is_active:
            return
        
        # Format with speaker attribution
        formatted = f"[{event.kind}] {event.speaker}: {event.text}"
        
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[types.Part(text=formatted)],
            )
        )
        self.text_inputs += 1
    
    async def handle_video_frame(self, jpeg_data: bytes):
        """
        Process a video frame from the meeting.
        Sends it to Gemini as a JPEG image blob via send_realtime().
        """
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
        """Process a text message from the dashboard (direct user instruction)."""
        if not self._live_queue or not self._is_active:
            return
        
        self._live_queue.send_content(
            types.Content(
                role="user",
                parts=[types.Part(text=f"[dashboard instruction] {text}")],
            )
        )
    
    async def _process_responses(self, run_config: RunConfig):
        """
        Main loop that processes Gemini's responses.
        Routes text responses to speak/chat commands.
        """
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
            logger.error(f"Gemini response processing error: {e}")
    
    async def _handle_agent_event(self, event):
        """Handle a single event from the Gemini agent."""
        try:
            # Check for text content in the event
            if not hasattr(event, 'content') or not event.content:
                return
            
            for part in event.content.parts:
                # Text response from the agent
                if hasattr(part, 'text') and part.text:
                    text = part.text.strip()
                    if not text:
                        continue
                    
                    self.responses_generated += 1
                    logger.info(f"Agent response [{self.role.role_name}]: {text[:100]}...")
                    
                    # Decide: speak or chat based on the response
                    await self._dispatch_response(text)
                
                # Handle tool calls (take_note, flag_action_item, etc.)
                # ADK handles tool execution automatically
        
        except Exception as e:
            logger.error(f"Error handling agent event: {e}")
    
    async def _dispatch_response(self, text: str):
        """
        Decide how to deliver the agent's response to the meeting.
        
        Strategy:
        - Short responses (<200 chars) → speak via TTS
        - Long responses → speak a summary, put full text in chat
        - Observer mode → never speak, only accumulate
        """
        from app.meetmind_agent.roles import ParticipationMode
        
        if self.role.mode == ParticipationMode.OBSERVER:
            # Observer mode: never speak, just log
            logger.info(f"[Observer] Noted: {text[:100]}...")
            return
        
        if len(text) <= 200:
            # Short enough to speak directly
            await self.command_sender.speak(text)
        else:
            # Too long to speak — speak a summary, put full text in chat
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
