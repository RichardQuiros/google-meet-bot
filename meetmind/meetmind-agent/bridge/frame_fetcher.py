"""
MeetMind Frame Fetcher
Downloads JPEG video frames from meet-control-server for Gemini vision input.
Implements a "latest wins" strategy — only fetches the most recent frame,
skipping stale ones to minimize latency.
"""

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class FrameFetcher:
    """
    Fetches JPEG video frames from the control server.
    
    Strategy: "latest wins" — if a new frame arrives while we're still
    downloading the previous one, we skip the old one and fetch the new one.
    This keeps latency low for the Gemini vision pipeline.
    """
    
    def __init__(
        self,
        control_base_url: str = "http://localhost:3001",
        meeting_id: str = "default",
    ):
        self.base_url = control_base_url.rstrip("/")
        self.meeting_id = meeting_id
        self._client: Optional[httpx.AsyncClient] = None
        self.frames_fetched = 0
        self.frames_skipped = 0
        self.fetch_errors = 0
    
    async def start(self):
        """Initialize the HTTP client."""
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
        )
    
    async def stop(self):
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
        logger.info(
            f"Frame fetcher stopped. Fetched: {self.frames_fetched}, "
            f"Skipped: {self.frames_skipped}, Errors: {self.fetch_errors}"
        )
    
    async def fetch_frame(self, frame_url: str) -> Optional[bytes]:
        """
        Download a single JPEG frame from the given URL.
        
        Returns raw JPEG bytes or None if the fetch failed.
        """
        if not self._client:
            return None
        
        try:
            response = await self._client.get(frame_url)
            
            if response.status_code == 200:
                self.frames_fetched += 1
                return response.content
            else:
                self.fetch_errors += 1
                logger.warning(f"Frame fetch failed: {response.status_code} from {frame_url}")
                return None
                
        except httpx.TimeoutException:
            self.fetch_errors += 1
            logger.warning(f"Frame fetch timeout: {frame_url}")
            return None
        except Exception as e:
            self.fetch_errors += 1
            logger.error(f"Frame fetch error: {e}")
            return None
    
    async def fetch_latest_frame(self) -> Optional[bytes]:
        """
        Fetch the most recent video frame from the meeting.
        Uses the /video-frames/latest endpoint.
        """
        url = f"{self.base_url}/meetings/{self.meeting_id}/video-frames/latest"
        
        try:
            response = await self._client.get(url)
            
            if response.status_code == 200:
                data = response.json()
                frame_id = data.get("frameId")
                if frame_id:
                    image_url = f"{self.base_url}/meetings/{self.meeting_id}/video-frames/{frame_id}/image"
                    return await self.fetch_frame(image_url)
            
            return None
            
        except Exception as e:
            logger.error(f"Latest frame fetch error: {e}")
            return None
    
    def build_frame_url(self, frame_id: str) -> str:
        """Build the URL for a specific frame ID."""
        return f"{self.base_url}/meetings/{self.meeting_id}/video-frames/{frame_id}/image"
