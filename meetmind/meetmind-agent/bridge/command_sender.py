"""
MeetMind Command Sender
Sends commands (join, chat, speak) to the meet-control-server REST API.
This is how our Gemini agent takes actions in the meeting.
"""

import asyncio
import logging
from typing import Optional
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


@dataclass
class CommandResult:
    """Result of a command sent to the control server."""
    success: bool
    command_id: Optional[str] = None
    error: Optional[str] = None
    data: Optional[dict] = None


class CommandSender:
    """
    Sends commands to meet-control-server to take actions in the meeting.
    
    Actions:
    - join: Tell the bot to join a Google Meet
    - leave: Tell the bot to leave/reset the active Google Meet session
    - chat: Send a text message in the Meet chat
    - speak: Speak via TTS in the meeting
    """
    
    def __init__(
        self,
        control_base_url: str = "http://localhost:3001",
        bot_id: str = "bot-01",
        meeting_id: str = "default",
    ):
        self.base_url = control_base_url.rstrip("/")
        self.bot_id = bot_id
        self.meeting_id = meeting_id
        self._client: Optional[httpx.AsyncClient] = None
    
    async def start(self):
        """Initialize the HTTP client."""
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        logger.info(f"Command sender ready: {self.base_url} (bot: {self.bot_id})")
    
    async def stop(self):
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
    
    async def join(
        self,
        meeting_url: str,
        display_name: str = "MeetMind AI",
        camera: bool = False,
        microphone: bool = True,
    ) -> CommandResult:
        """
        Tell the bot to join a Google Meet session.
        
        Args:
            meeting_url: The Google Meet URL (e.g., https://meet.google.com/abc-defg-hij)
            display_name: Name shown in the meeting participant list
            camera: Whether to enable camera (usually False)
            microphone: Whether to enable microphone (True for speaking)
        """
        return await self._send_command(
            f"/bots/{self.bot_id}/join",
            {
                "meetingId": self.meeting_id,
                "meetingUrl": meeting_url,
                "displayName": display_name,
                "camera": camera,
                "microphone": microphone,
            },
        )

    async def leave(self, wait_for_completion: bool = True, timeout_s: float = 20.0) -> CommandResult:
        """Tell the bot to leave/reset the active meeting session."""
        result = await self._send_command(
            f"/bots/{self.bot_id}/leave",
            {
                "meetingId": self.meeting_id,
            },
        )
        if not result.success or not wait_for_completion or not result.command_id:
            return result

        completion = await self._wait_for_command_completion(result.command_id, timeout_s=timeout_s)
        if completion is None:
            return CommandResult(
                success=False,
                command_id=result.command_id,
                error="Leave command timed out while waiting for completion",
                data=result.data,
            )
        return completion
    
    async def speak(
        self,
        text: str,
        voice: Optional[str] = None,
        rate: Optional[float] = None,
        pitch: Optional[float] = None,
        volume: Optional[float] = None,
    ) -> CommandResult:
        """
        Make the bot speak in the meeting via TTS.
        
        This is the primary way the Gemini agent communicates with meeting participants.
        
        Args:
            text: What to say
            voice: TTS voice name (depends on TTS backend)
            rate: Speech rate multiplier
            pitch: Pitch adjustment
            volume: Volume level
        """
        payload = {
            "meetingId": self.meeting_id,
            "text": text,
        }
        if voice:
            payload["voice"] = voice
        if rate is not None:
            payload["rate"] = rate
        if pitch is not None:
            payload["pitch"] = pitch
        if volume is not None:
            payload["volume"] = volume
        
        result = await self._send_command(f"/bots/{self.bot_id}/speak", payload)
        
        if result.success:
            logger.info(f"Speaking: {text[:80]}...")
        else:
            logger.error(f"Speak failed: {result.error}")
        
        return result
    
    async def chat(self, text: str) -> CommandResult:
        """
        Send a text message in the Google Meet chat panel.
        
        Use this for non-verbal communication (sharing links, writing notes, etc.)
        
        Args:
            text: Message to send in the Meet chat
        """
        result = await self._send_command(
            f"/bots/{self.bot_id}/chat",
            {
                "meetingId": self.meeting_id,
                "text": text,
            },
        )
        
        if result.success:
            logger.info(f"Chat sent: {text[:80]}...")
        else:
            logger.error(f"Chat failed: {result.error}")
        
        return result
    
    async def get_timeline(self, limit: int = 100) -> Optional[dict]:
        """Fetch the meeting timeline (history of events)."""
        try:
            response = await self._client.get(
                f"/meetings/{self.meeting_id}/timeline",
                params={"limit": limit},
            )
            if response.status_code == 200:
                return response.json()
            return None
        except Exception as e:
            logger.error(f"Failed to get timeline: {e}")
            return None
    
    async def get_messages(self) -> list[dict]:
        """Fetch all chat messages from the meeting."""
        try:
            response = await self._client.get(f"/meetings/{self.meeting_id}/messages")
            if response.status_code == 200:
                return response.json()
            return []
        except Exception as e:
            logger.error(f"Failed to get messages: {e}")
            return []
    
    async def get_transcripts(self) -> list[dict]:
        """Fetch all audio transcripts from the meeting."""
        try:
            response = await self._client.get(f"/meetings/{self.meeting_id}/audio-transcripts")
            if response.status_code == 200:
                return response.json()
            return []
        except Exception as e:
            logger.error(f"Failed to get transcripts: {e}")
            return []
    
    async def _send_command(self, path: str, payload: dict) -> CommandResult:
        """Send a command to the control server."""
        if not self._client:
            return CommandResult(success=False, error="Client not started")
        
        try:
            response = await self._client.post(path, json=payload)
            data = response.json()
            
            if response.status_code in (200, 201):
                return CommandResult(
                    success=True,
                    command_id=data.get("id"),
                    data=data,
                )
            else:
                return CommandResult(
                    success=False,
                    error=data.get("error", f"HTTP {response.status_code}"),
                    data=data,
                )
        except httpx.ConnectError:
            return CommandResult(success=False, error=f"Cannot connect to control server at {self.base_url}")
        except httpx.TimeoutException:
            return CommandResult(success=False, error="Command timed out")
        except Exception as e:
            return CommandResult(success=False, error=str(e))

    async def _wait_for_command_completion(
        self,
        command_id: str,
        *,
        timeout_s: float = 20.0,
        poll_interval_s: float = 0.35,
    ) -> Optional[CommandResult]:
        if not self._client:
            return None

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s

        while loop.time() < deadline:
            try:
                response = await self._client.get(f"/commands/{command_id}")
                if response.status_code != 200:
                    await asyncio.sleep(poll_interval_s)
                    continue

                data = response.json()
                status = data.get("status")
                if status == "completed":
                    return CommandResult(
                        success=True,
                        command_id=command_id,
                        data=data,
                    )
                if status == "failed":
                    return CommandResult(
                        success=False,
                        command_id=command_id,
                        error=data.get("error", "Command failed"),
                        data=data,
                    )
            except Exception as error:
                logger.warning("Command status poll failed for %s: %s", command_id, error)

            await asyncio.sleep(poll_interval_s)

        return None
