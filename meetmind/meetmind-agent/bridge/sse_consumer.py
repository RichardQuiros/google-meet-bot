"""
MeetMind SSE Consumer
Connects to the meet-control-server SSE event stream and routes
meeting events (text, audio transcripts, video frames) to the Gemini agent.
"""

import asyncio
import json
import logging
import os
from typing import Optional, Callable, Awaitable
from dataclasses import dataclass, field
from enum import Enum

import httpx

logger = logging.getLogger(__name__)


class EventKind(str, Enum):
    CHAT = "chat.message.detected"
    CAPTION = "caption.segment.detected"
    AUDIO_TRANSCRIPT = "audio.transcript.detected"
    VIDEO_FRAME = "video.frame.detected"
    VIDEO_ACTIVITY = "video.activity.detected"
    BOT_STATUS = "bot.status.changed"
    COMMAND_STARTED = "command.started"
    COMMAND_COMPLETED = "command.completed"
    COMMAND_FAILED = "command.failed"
    SPEECH_COMPLETED = "speech.output.completed"
    SPEECH_FAILED = "speech.output.failed"
    MEDIA_TRANSPORT_READY = "media.transport.ready"
    MEDIA_TRANSPORT_FAILED = "media.transport.failed"
    HEARTBEAT = "heartbeat"
    CONNECTED = "connected"
    SNAPSHOT = "snapshot"


@dataclass
class TextEvent:
    """Normalized text event from any source (chat, caption, audio transcript)."""
    kind: str  # "chat" | "caption" | "audioTranscript"
    text: str
    speaker: str
    occurred_at: str
    raw: dict


@dataclass
class VideoFrameEvent:
    """Video frame metadata from the control server."""
    frame_id: str
    captured_at: str
    width: int
    height: int
    frame_url: str
    raw: dict


@dataclass
class BotStatusEvent:
    """Bot status change."""
    status: str
    error: Optional[str] = None


@dataclass
class RtpAudioTransport:
    """RTP audio transport descriptor from the control server."""
    host: str
    port: int
    sample_rate: int
    channels: int
    direction: str
    sdp: str


@dataclass
class MediaTransportEvent:
    """Realtime media transport descriptor set."""
    audio_input: Optional[RtpAudioTransport] = None
    meeting_audio_output: Optional[RtpAudioTransport] = None
    raw: dict = field(default_factory=dict)


# Type aliases for callbacks
OnTextCallback = Callable[[TextEvent], Awaitable[None]]
OnFrameCallback = Callable[[VideoFrameEvent], Awaitable[None]]
OnStatusCallback = Callable[[BotStatusEvent], Awaitable[None]]
OnMediaTransportCallback = Callable[[MediaTransportEvent], Awaitable[None]]


class SSEConsumer:
    """
    Consumes Server-Sent Events from meet-control-server and dispatches
    them to registered callbacks.
    
    This is the bridge between the meet-bot infrastructure and our Gemini agent.
    """
    
    def __init__(
        self,
        control_base_url: str = "http://localhost:3001",
        meeting_id: str = "default",
    ):
        self.base_url = control_base_url.rstrip("/")
        self.meeting_id = meeting_id
        self.snapshot_limit = max(0, int(os.getenv("MEET_SSE_SNAPSHOT_LIMIT", "50")))
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[httpx.AsyncClient] = None
        
        # Callbacks
        self._on_text: Optional[OnTextCallback] = None
        self._on_frame: Optional[OnFrameCallback] = None
        self._on_status: Optional[OnStatusCallback] = None
        self._on_media_transport: Optional[OnMediaTransportCallback] = None
        
        # Stats
        self.events_received = 0
        self.text_events = 0
        self.frame_events = 0
        self.errors = 0
    
    def on_text(self, callback: OnTextCallback):
        """Register callback for text events (chat, captions, audio transcripts)."""
        self._on_text = callback
        return self
    
    def on_frame(self, callback: OnFrameCallback):
        """Register callback for video frame events."""
        self._on_frame = callback
        return self
    
    def on_status(self, callback: OnStatusCallback):
        """Register callback for bot status changes."""
        self._on_status = callback
        return self

    def on_media_transport(self, callback: OnMediaTransportCallback):
        """Register callback for realtime RTP transport availability."""
        self._on_media_transport = callback
        return self
    
    async def start(self):
        """Start consuming the SSE stream."""
        if self._running:
            return
        
        self._running = True
        self._client = httpx.AsyncClient(timeout=None)
        self._task = asyncio.create_task(self._consume_loop())
        logger.info(f"SSE consumer started: {self.base_url}/meetings/{self.meeting_id}/events/stream")
    
    async def stop(self):
        """Stop consuming."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()
        logger.info(f"SSE consumer stopped. Events: {self.events_received}, Texts: {self.text_events}, Frames: {self.frame_events}, Errors: {self.errors}")
    
    async def _consume_loop(self):
        """Main SSE consumption loop with reconnection."""
        reconnect_delay = 1.0
        max_delay = 30.0
        
        while self._running:
            try:
                url = (
                    f"{self.base_url}/meetings/{self.meeting_id}/events/stream"
                    f"?snapshotLimit={self.snapshot_limit}"
                )
                logger.info(f"Connecting to SSE stream: {url}")
                
                async with self._client.stream("GET", url) as response:
                    if response.status_code != 200:
                        logger.error(f"SSE connection failed: {response.status_code}")
                        await asyncio.sleep(reconnect_delay)
                        reconnect_delay = min(reconnect_delay * 2, max_delay)
                        continue
                    
                    # Reset reconnect delay on successful connection
                    reconnect_delay = 1.0
                    logger.info("SSE stream connected")
                    
                    event_type = None
                    data_buffer = []
                    
                    async for line in response.aiter_lines():
                        if not self._running:
                            break
                        
                        line = line.strip()
                        
                        if not line:
                            # Empty line = end of event
                            if event_type and data_buffer:
                                data_str = "\n".join(data_buffer)
                                await self._dispatch_event(event_type, data_str)
                            event_type = None
                            data_buffer = []
                            continue
                        
                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            data_buffer.append(line[5:].strip())
                        elif line.startswith(":"):
                            # Comment / keepalive
                            pass
                            
            except asyncio.CancelledError:
                break
            except httpx.ReadTimeout:
                logger.warning("SSE stream read timeout, reconnecting...")
                await asyncio.sleep(reconnect_delay)
            except httpx.ConnectError:
                logger.warning(f"Cannot connect to control server at {self.base_url}, retrying in {reconnect_delay:.0f}s...")
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_delay)
            except Exception as e:
                self.errors += 1
                logger.error(f"SSE consumer error: {e}")
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_delay)
    
    async def _dispatch_event(self, event_type: str, data_str: str):
        """Parse and route an SSE event to the appropriate callback."""
        self.events_received += 1
        
        try:
            payload = json.loads(data_str)
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON in SSE event: {event_type}")
            return
        
        try:
            if event_type == EventKind.SNAPSHOT:
                await self._dispatch_snapshot(payload)
                logger.info(
                    "SSE snapshot received with %s events",
                    len(payload.get("events", [])) if isinstance(payload, dict) else 0,
                )
                return

            if event_type == EventKind.CHAT and self._on_text:
                event = TextEvent(
                    kind="chat",
                    text=payload.get("payload", {}).get("text", ""),
                    speaker=payload.get("payload", {}).get("author", "Unknown"),
                    occurred_at=payload.get("payload", {}).get("sentAt", ""),
                    raw=payload,
                )
                self.text_events += 1
                await self._on_text(event)
            
            elif event_type == EventKind.CAPTION and self._on_text:
                event = TextEvent(
                    kind="caption",
                    text=payload.get("payload", {}).get("text", ""),
                    speaker=payload.get("payload", {}).get("speaker", "Unknown"),
                    occurred_at=payload.get("payload", {}).get("startAt", ""),
                    raw=payload,
                )
                self.text_events += 1
                await self._on_text(event)
            
            elif event_type == EventKind.AUDIO_TRANSCRIPT and self._on_text:
                event = TextEvent(
                    kind="audioTranscript",
                    text=payload.get("payload", {}).get("text", ""),
                    speaker=payload.get("payload", {}).get("speaker", "Unknown"),
                    occurred_at=payload.get("payload", {}).get("startedAt", ""),
                    raw=payload,
                )
                self.text_events += 1
                await self._on_text(event)
            
            elif event_type == EventKind.VIDEO_FRAME and self._on_frame:
                p = payload.get("payload", {})
                frame_id = p.get("frameId", "")
                frame_url = p.get("frameUrl") or f"{self.base_url}/meetings/{self.meeting_id}/video-frames/{frame_id}/image"
                
                event = VideoFrameEvent(
                    frame_id=frame_id,
                    captured_at=p.get("capturedAt", ""),
                    width=p.get("width", 0),
                    height=p.get("height", 0),
                    frame_url=frame_url,
                    raw=payload,
                )
                self.frame_events += 1
                await self._on_frame(event)
            
            elif event_type == EventKind.BOT_STATUS and self._on_status:
                p = payload.get("payload", {})
                event = BotStatusEvent(
                    status=p.get("status", "unknown"),
                    error=p.get("error"),
                )
                await self._on_status(event)

            elif event_type == EventKind.MEDIA_TRANSPORT_READY and self._on_media_transport:
                transport = payload.get("payload", {}).get("transport", {})
                event = MediaTransportEvent(
                    audio_input=self._parse_audio_transport(transport.get("audioInput")),
                    meeting_audio_output=self._parse_audio_transport(
                        transport.get("meetingAudioOutput")
                    ),
                    raw=payload,
                )
                await self._on_media_transport(event)
            
            elif event_type == EventKind.CONNECTED:
                logger.info(f"SSE connected event: {payload}")
            
        except Exception as e:
            self.errors += 1
            logger.error(f"Error dispatching event {event_type}: {e}")

    async def _dispatch_snapshot(self, payload: dict):
        """Recover the latest transport and status events from a stream snapshot."""
        events = payload.get("events", []) if isinstance(payload, dict) else []
        if not events:
            return

        latest_transport_ready = None
        latest_transport_failed = None
        latest_bot_status = None

        for event in reversed(events):
            event_type = event.get("type")
            if latest_transport_ready is None and event_type == EventKind.MEDIA_TRANSPORT_READY:
                latest_transport_ready = event
            elif latest_transport_failed is None and event_type == EventKind.MEDIA_TRANSPORT_FAILED:
                latest_transport_failed = event
            elif latest_bot_status is None and event_type == EventKind.BOT_STATUS:
                latest_bot_status = event

            if latest_transport_ready and latest_transport_failed and latest_bot_status:
                break

        if latest_bot_status and self._on_status:
            p = latest_bot_status.get("payload", {})
            await self._on_status(
                BotStatusEvent(
                    status=p.get("status", "unknown"),
                    error=p.get("error"),
                )
            )

        if latest_transport_ready and self._on_media_transport:
            transport = latest_transport_ready.get("payload", {}).get("transport", {})
            await self._on_media_transport(
                MediaTransportEvent(
                    audio_input=self._parse_audio_transport(transport.get("audioInput")),
                    meeting_audio_output=self._parse_audio_transport(
                        transport.get("meetingAudioOutput")
                    ),
                    raw=latest_transport_ready,
                )
            )
        elif latest_transport_failed:
            logger.warning("Latest snapshot transport event is failure: %s", latest_transport_failed)

    def _parse_audio_transport(self, payload: Optional[dict]) -> Optional[RtpAudioTransport]:
        """Normalize an RTP audio transport descriptor from event payload."""
        if not payload:
            return None

        return RtpAudioTransport(
            host=payload.get("host", ""),
            port=payload.get("port", 0),
            sample_rate=payload.get("sampleRate", 16000),
            channels=payload.get("channels", 1),
            direction=payload.get("direction", ""),
            sdp=payload.get("sdp", ""),
        )
