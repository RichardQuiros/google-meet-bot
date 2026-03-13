"""
MeetMind Agent Service
FastAPI server that orchestrates:
- SSE consumption from meet-control-server (bridge layer)
- Gemini Live API session (brain layer)
- Command dispatch back to meet-control-server (action layer)
- Dashboard API for the React frontend

This is Layer 3 — the AI intelligence layer.
"""

import asyncio
import json
import os
import logging
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from bridge.sse_consumer import SSEConsumer, TextEvent, VideoFrameEvent, BotStatusEvent
from bridge.command_sender import CommandSender
from bridge.frame_fetcher import FrameFetcher
from gemini.live_session import GeminiLiveSession
from app.meetmind_agent.roles import (
    RoleConfig, ParticipationMode, PREDEFINED_ROLES,
    get_role, create_custom_role, list_roles,
)
from app.meetmind_agent.tools import (
    get_session_notes, get_session_action_items,
    get_session_summary_context, clear_session_data,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("meetmind")

# ── Configuration ──
CONTROL_BASE_URL = os.getenv("CONTROL_BASE_URL", "http://localhost:3001")
BOT_ID = os.getenv("BOT_ID", "bot-01")
MEETING_ID = os.getenv("MEETING_ID", "meetmind-session")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8080"))

# ── Global State ──
active_session: dict = {}
dashboard_ws_clients: list[WebSocket] = []


# ── Lifespan ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("MeetMind Agent Service starting...")
    yield
    # Cleanup active session
    if active_session:
        await _stop_session()
    logger.info("MeetMind Agent Service stopped.")


# ── App ──
app = FastAPI(
    title="MeetMind Agent Service",
    description="AI meeting participant powered by Gemini Live API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request/Response Models ──

class DeployRequest(BaseModel):
    meeting_url: str
    role_id: str = "meeting_scribe"
    custom_role_name: Optional[str] = None
    custom_role_description: Optional[str] = None
    custom_role_mode: Optional[str] = "reactive"
    vision_enabled: bool = True
    display_name: str = "MeetMind AI"
    meeting_id: Optional[str] = None
    bot_id: Optional[str] = None


class DeployResponse(BaseModel):
    session_id: str
    role_name: str
    mode: str
    status: str
    meeting_id: str
    bot_id: str


class SessionStatus(BaseModel):
    active: bool
    role_name: Optional[str] = None
    mode: Optional[str] = None
    bot_status: Optional[str] = None
    meeting_id: Optional[str] = None
    stats: Optional[dict] = None


class EndSessionResponse(BaseModel):
    notes: list[dict]
    action_items: list[dict]
    summary_context: str
    gemini_stats: dict


class DashboardMessage(BaseModel):
    text: str


# ── REST API ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "meetmind-agent"}


@app.get("/api/roles")
async def get_available_roles():
    """List all available predefined roles."""
    return {"roles": list_roles()}


@app.post("/api/deploy", response_model=DeployResponse)
async def deploy_agent(req: DeployRequest):
    """Deploy the MeetMind agent into a Google Meet session."""
    
    if active_session.get("is_active"):
        raise HTTPException(status_code=409, detail="A session is already active. End it first.")
    
    # Resolve role
    if req.role_id == "custom" and req.custom_role_name:
        role = create_custom_role(
            name=req.custom_role_name,
            description=req.custom_role_description or "Custom meeting participant",
            mode=ParticipationMode(req.custom_role_mode or "reactive"),
            vision_enabled=req.vision_enabled,
        )
    else:
        role = get_role(req.role_id)
        if not role:
            raise HTTPException(status_code=400, detail=f"Unknown role: {req.role_id}")
    
    role.vision_enabled = req.vision_enabled
    
    meeting_id = req.meeting_id or MEETING_ID
    bot_id = req.bot_id or BOT_ID
    
    # Initialize components
    command_sender = CommandSender(
        control_base_url=CONTROL_BASE_URL,
        bot_id=bot_id,
        meeting_id=meeting_id,
    )
    await command_sender.start()
    
    frame_fetcher = FrameFetcher(
        control_base_url=CONTROL_BASE_URL,
        meeting_id=meeting_id,
    )
    await frame_fetcher.start()
    
    gemini_session = GeminiLiveSession(
        role=role,
        command_sender=command_sender,
        session_id=f"meetmind_{role.role_id}_{meeting_id}",
    )
    
    sse_consumer = SSEConsumer(
        control_base_url=CONTROL_BASE_URL,
        meeting_id=meeting_id,
    )
    
    # Wire SSE events to Gemini
    async def on_text(event: TextEvent):
        await gemini_session.handle_text_event(event)
        await _broadcast_to_dashboard({
            "type": "transcript",
            "kind": event.kind,
            "speaker": event.speaker,
            "text": event.text,
            "is_agent": False,
        })
    
    async def on_frame(event: VideoFrameEvent):
        jpeg_data = await frame_fetcher.fetch_frame(event.frame_url)
        if jpeg_data:
            await gemini_session.handle_video_frame(jpeg_data)
            await _broadcast_to_dashboard({
                "type": "frame_received",
                "frame_id": event.frame_id,
            })
    
    async def on_status(event: BotStatusEvent):
        active_session["bot_status"] = event.status
        await _broadcast_to_dashboard({
            "type": "bot_status",
            "status": event.status,
            "error": event.error,
        })
    
    sse_consumer.on_text(on_text).on_frame(on_frame).on_status(on_status)
    
    # Store session state
    active_session.update({
        "is_active": True,
        "role": role,
        "meeting_id": meeting_id,
        "bot_id": bot_id,
        "meeting_url": req.meeting_url,
        "command_sender": command_sender,
        "frame_fetcher": frame_fetcher,
        "gemini_session": gemini_session,
        "sse_consumer": sse_consumer,
        "bot_status": "initializing",
    })
    
    # Start Gemini session
    await gemini_session.start()
    
    # Start SSE consumption
    await sse_consumer.start()
    
    # Tell the bot to join the meeting
    join_result = await command_sender.join(
        meeting_url=req.meeting_url,
        display_name=req.display_name,
        camera=False,
        microphone=True,
    )
    
    status = "joining" if join_result.success else f"join_failed: {join_result.error}"
    active_session["bot_status"] = status
    
    return DeployResponse(
        session_id=gemini_session.session_id,
        role_name=role.role_name,
        mode=role.mode.value,
        status=status,
        meeting_id=meeting_id,
        bot_id=bot_id,
    )


@app.get("/api/session", response_model=SessionStatus)
async def get_session_status():
    """Get current session status."""
    if not active_session.get("is_active"):
        return SessionStatus(active=False)
    
    gemini: GeminiLiveSession = active_session.get("gemini_session")
    
    return SessionStatus(
        active=True,
        role_name=active_session["role"].role_name,
        mode=active_session["role"].mode.value,
        bot_status=active_session.get("bot_status", "unknown"),
        meeting_id=active_session.get("meeting_id"),
        stats=gemini.get_stats() if gemini else None,
    )


@app.post("/api/session/message")
async def send_dashboard_message(msg: DashboardMessage):
    """Send a message from the dashboard directly to the Gemini agent."""
    gemini: GeminiLiveSession = active_session.get("gemini_session")
    if not gemini:
        raise HTTPException(status_code=404, detail="No active session")
    
    await gemini.handle_dashboard_message(msg.text)
    
    await _broadcast_to_dashboard({
        "type": "transcript",
        "kind": "dashboard",
        "speaker": "Dashboard",
        "text": msg.text,
        "is_agent": False,
    })
    
    return {"status": "sent"}


@app.post("/api/session/end", response_model=EndSessionResponse)
async def end_session():
    """End the current meeting session and get the summary."""
    if not active_session.get("is_active"):
        raise HTTPException(status_code=404, detail="No active session")
    
    gemini: GeminiLiveSession = active_session.get("gemini_session")
    stats = gemini.get_stats() if gemini else {}
    
    await _stop_session()
    
    notes = get_session_notes()
    action_items = get_session_action_items()
    summary_context = get_session_summary_context()
    clear_session_data()
    
    return EndSessionResponse(
        notes=notes,
        action_items=action_items,
        summary_context=summary_context,
        gemini_stats=stats,
    )


# ── WebSocket for Dashboard Live Events ──

@app.websocket("/ws/dashboard")
async def dashboard_websocket(websocket: WebSocket):
    """WebSocket for real-time dashboard updates."""
    await websocket.accept()
    dashboard_ws_clients.append(websocket)
    logger.info(f"Dashboard client connected. Total: {len(dashboard_ws_clients)}")
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            if msg.get("type") == "message":
                # Forward dashboard message to Gemini
                gemini: GeminiLiveSession = active_session.get("gemini_session")
                if gemini:
                    await gemini.handle_dashboard_message(msg.get("text", ""))
            
            elif msg.get("type") == "end":
                await end_session()
                break
                
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in dashboard_ws_clients:
            dashboard_ws_clients.remove(websocket)
        logger.info(f"Dashboard client disconnected. Total: {len(dashboard_ws_clients)}")


async def _broadcast_to_dashboard(message: dict):
    """Send an event to all connected dashboard clients."""
    if not dashboard_ws_clients:
        return
    
    data = json.dumps(message)
    disconnected = []
    
    for ws in dashboard_ws_clients:
        try:
            await ws.send_text(data)
        except Exception:
            disconnected.append(ws)
    
    for ws in disconnected:
        dashboard_ws_clients.remove(ws)


async def _stop_session():
    """Stop all session components."""
    sse: SSEConsumer = active_session.get("sse_consumer")
    gemini: GeminiLiveSession = active_session.get("gemini_session")
    cmd: CommandSender = active_session.get("command_sender")
    ff: FrameFetcher = active_session.get("frame_fetcher")
    
    if sse:
        await sse.stop()
    if gemini:
        await gemini.stop()
    if cmd:
        await cmd.stop()
    if ff:
        await ff.stop()
    
    active_session.clear()
    logger.info("Session stopped and cleaned up")


# ── Entry Point ──

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=os.getenv("DEBUG", "false").lower() == "true",
        ws_max_size=16 * 1024 * 1024,
    )
