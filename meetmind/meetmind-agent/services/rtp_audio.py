"""Async RTP audio helpers backed by ffmpeg."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

from bridge.sse_consumer import RtpAudioTransport

logger = logging.getLogger(__name__)


class AsyncRtpAudioReceiver:
    """Receive RTP audio and expose it as raw PCM chunks."""

    def __init__(
        self,
        transport: RtpAudioTransport,
        *,
        ffmpeg_path: Optional[str] = None,
        chunk_duration_ms: int = 20,
    ):
        if transport.direction != "sendonly":
            raise ValueError("AsyncRtpAudioReceiver requires a sendonly RTP descriptor")

        self.transport = transport
        self.ffmpeg_path = ffmpeg_path or os.getenv("FFMPEG_PATH", "ffmpeg")
        bytes_per_ms = (transport.sample_rate * transport.channels * 2) / 1000
        self.chunk_size = max(
            transport.channels * 2,
            int(bytes_per_ms * max(chunk_duration_ms, 10)),
        )
        self._process: Optional[asyncio.subprocess.Process] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._sdp_path: Optional[Path] = None

    async def start(self):
        if self._process:
            return

        fd, temp_path = tempfile.mkstemp(prefix="meetmind-meeting-audio-", suffix=".sdp")
        os.close(fd)
        self._sdp_path = Path(temp_path)
        self._sdp_path.write_text(f"{self.transport.sdp}\n", encoding="utf-8")

        args = [
            self.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-analyzeduration",
            "0",
            "-probesize",
            "32",
            "-protocol_whitelist",
            "file,udp,rtp",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-max_delay",
            "0",
            "-i",
            str(self._sdp_path),
            "-f",
            "s16le",
            "-ac",
            str(self.transport.channels),
            "-ar",
            str(self.transport.sample_rate),
            "pipe:1",
        ]

        self._process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr("rtp-audio-receiver"))

    async def iter_chunks(self):
        if not self._process or not self._process.stdout:
            raise RuntimeError("RTP audio receiver has not been started")

        while True:
            chunk = await self._process.stdout.read(self.chunk_size)
            if not chunk:
                break
            yield chunk

    async def close(self):
        await self._stop_process()
        if self._sdp_path:
            self._sdp_path.unlink(missing_ok=True)
            self._sdp_path = None

    async def _stop_process(self):
        if not self._process:
            return

        if self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=3)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()

        if self._stderr_task:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass
            self._stderr_task = None

        self._process = None

    async def _drain_stderr(self, label: str):
        if not self._process or not self._process.stderr:
            return

        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            logger.warning("%s: %s", label, line.decode("utf-8", errors="ignore").strip())


class AsyncRtpAudioSender:
    """Send raw PCM chunks to an RTP endpoint."""

    def __init__(
        self,
        transport: RtpAudioTransport,
        *,
        ffmpeg_path: Optional[str] = None,
    ):
        if transport.direction != "recvonly":
            raise ValueError("AsyncRtpAudioSender requires a recvonly RTP descriptor")

        self.transport = transport
        self.ffmpeg_path = ffmpeg_path or os.getenv("FFMPEG_PATH", "ffmpeg")
        self._process: Optional[asyncio.subprocess.Process] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._stderr_buffer: list[str] = []

    async def start(self):
        if self._process:
            return

        args = [
            self.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-flush_packets",
            "1",
            "-f",
            "s16le",
            "-ar",
            str(self.transport.sample_rate),
            "-ac",
            str(self.transport.channels),
            "-i",
            "pipe:0",
            "-acodec",
            "pcm_s16be",
            "-payload_type",
            "96",
            "-f",
            "rtp",
            f"rtp://{self.transport.host}:{self.transport.port}",
        ]

        self._stderr_buffer = []
        self._process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr("rtp-audio-sender"))

    async def write_pcm(self, chunk: bytes):
        if not chunk:
            return
        if not self._process or not self._process.stdin:
            raise RuntimeError("RTP audio sender has not been started")
        if self._process.returncode is not None:
            raise RuntimeError(
                "RTP audio sender exited before write"
                + (f": {self._last_stderr_line()}" if self._stderr_buffer else "")
            )

        self._process.stdin.write(chunk)
        await self._process.stdin.drain()

    async def reset(self):
        """Restart the RTP sender to flush any queued audio after interruption."""
        await self.close()
        await self.start()

    async def close(self):
        if not self._process:
            return

        process = self._process
        if process.stdin and not process.stdin.is_closing():
            process.stdin.close()

        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

        if self._stderr_task:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass
            self._stderr_task = None

        self._process = None

    async def _drain_stderr(self, label: str):
        if not self._process or not self._process.stderr:
            return

        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="ignore").strip()
            if not decoded:
                continue
            self._stderr_buffer.append(decoded)
            if len(self._stderr_buffer) > 20:
                self._stderr_buffer = self._stderr_buffer[-20:]
            logger.warning("%s: %s", label, decoded)

    def _last_stderr_line(self) -> str:
        return self._stderr_buffer[-1] if self._stderr_buffer else ""
