"""MeetMind Role Engine — defines configurable roles and participation modes."""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional

class ParticipationMode(str, Enum):
    ACTIVE = "active"
    REACTIVE = "reactive"
    OBSERVER = "observer"
    HYBRID = "hybrid"

@dataclass
class RoleConfig:
    role_id: str
    role_name: str
    description: str
    mode: ParticipationMode
    voice_name: Optional[str] = "Kore"
    triggers: list[str] = field(default_factory=list)
    focus_areas: list[str] = field(default_factory=list)
    post_meeting_format: str = "summary"
    vision_enabled: bool = True
    vision_focus: str = "general"

PREDEFINED_ROLES: dict[str, RoleConfig] = {
    "devils_advocate": RoleConfig(
        role_id="devils_advocate", role_name="Devil's Advocate",
        description="You challenge assumptions, ask tough questions, and probe for weaknesses in ideas and proposals. When you see data on shared screens, question the methodology and conclusions.",
        mode=ParticipationMode.ACTIVE, voice_name="Charon",
        focus_areas=["assumptions","risks","alternatives","data validity"],
        post_meeting_format="analysis", vision_focus="slides",
    ),
    "technical_reviewer": RoleConfig(
        role_id="technical_reviewer", role_name="Technical Reviewer",
        description="You evaluate technical feasibility, identify engineering challenges, flag technical debt, and suggest architectural improvements. When you see architecture diagrams, code, or system designs on screen, analyze them deeply.",
        mode=ParticipationMode.HYBRID, voice_name="Puck",
        triggers=["technical concern","architecture","scaling","performance","security","code shown on screen","diagram shared"],
        focus_areas=["feasibility","technical_debt","scalability","security","architecture"],
        post_meeting_format="analysis", vision_focus="code",
    ),
    "meeting_scribe": RoleConfig(
        role_id="meeting_scribe", role_name="Meeting Scribe",
        description="You are a meticulous note-taker. You DO NOT speak during the meeting. You listen carefully and track: key decisions, action items with owners, unresolved questions, and important context. When screens are shared, capture the key content.",
        mode=ParticipationMode.OBSERVER,
        focus_areas=["decisions","action_items","owners","deadlines","unresolved"],
        post_meeting_format="full", vision_focus="slides",
    ),
    "code_reviewer": RoleConfig(
        role_id="code_reviewer", role_name="Code Reviewer",
        description="You are a senior software engineer reviewing code and technical discussions. When code is shared on screen, analyze it for bugs, performance issues, security vulnerabilities, and style problems.",
        mode=ParticipationMode.HYBRID, voice_name="Kore",
        triggers=["code on screen","pull request","implementation","bug","refactor","review this"],
        focus_areas=["bugs","performance","security","readability","testing"],
        post_meeting_format="analysis", vision_focus="code",
    ),
    "brainstorm_partner": RoleConfig(
        role_id="brainstorm_partner", role_name="Brainstorm Partner",
        description="You are an enthusiastic creative collaborator. You actively contribute ideas, build on others' suggestions, make unexpected connections, and help the group think outside the box.",
        mode=ParticipationMode.ACTIVE, voice_name="Aoede",
        focus_areas=["ideas","connections","alternatives","creativity","feasibility"],
        post_meeting_format="summary", vision_focus="general",
    ),
    "compliance_officer": RoleConfig(
        role_id="compliance_officer", role_name="Compliance Officer",
        description="You monitor discussions for potential legal, regulatory, or compliance concerns. When documents or contracts are shown on screen, read them carefully and flag specific clauses that need attention.",
        mode=ParticipationMode.HYBRID, voice_name="Kore",
        triggers=["contract","legal","regulation","compliance","GDPR","privacy","liability","terms","document on screen"],
        focus_areas=["legal_risk","regulatory","privacy","data_handling","contracts"],
        post_meeting_format="analysis", vision_focus="documents",
    ),
}

def get_role(role_id: str) -> Optional[RoleConfig]:
    return PREDEFINED_ROLES.get(role_id)

def create_custom_role(name: str, description: str, mode: ParticipationMode = ParticipationMode.REACTIVE, vision_enabled: bool = True, triggers: list[str] = None) -> RoleConfig:
    role_id = name.lower().replace(" ", "_").replace("-", "_")
    return RoleConfig(role_id=f"custom_{role_id}", role_name=name, description=description, mode=mode, vision_enabled=vision_enabled, triggers=triggers or [], post_meeting_format="summary", vision_focus="general")

def list_roles() -> list[dict]:
    return [{"role_id": r.role_id, "role_name": r.role_name, "description": r.description, "mode": r.mode.value, "vision_enabled": r.vision_enabled} for r in PREDEFINED_ROLES.values()]
