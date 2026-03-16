"""MeetMind Custom Tools — available to the agent during live meetings."""
from datetime import datetime

_session_notes: list[dict] = []
_session_action_items: list[dict] = []

def take_note(content: str, category: str = "general") -> str:
    """Record an important point, decision, or observation. Category: decision, insight, question, concern, screen_content, general."""
    _session_notes.append({"content": content, "category": category, "timestamp": datetime.now().isoformat()})
    return f"Note recorded: [{category}] {content[:80]}..."

def flag_action_item(task: str, owner: str = "unassigned", deadline: str = "not specified", priority: str = "medium") -> str:
    """Flag a task or commitment someone made. Priority: low, medium, high, critical."""
    _session_action_items.append({"task": task, "owner": owner, "deadline": deadline, "priority": priority, "timestamp": datetime.now().isoformat()})
    return f"Action item flagged: {task} -> {owner} (deadline: {deadline})"

def get_session_notes() -> list[dict]: return list(_session_notes)
def get_session_action_items() -> list[dict]: return list(_session_action_items)
def clear_session_data():
    _session_notes.clear()
    _session_action_items.clear()

def get_session_summary_context() -> str:
    parts = []
    if _session_notes:
        parts.append("== MEETING NOTES ==")
        for i, n in enumerate(_session_notes, 1):
            parts.append(f"{i}. [{n['category']}] {n['content']}")
    if _session_action_items:
        parts.append("\n== ACTION ITEMS ==")
        for i, a in enumerate(_session_action_items, 1):
            parts.append(f"{i}. {a['task']} | Owner: {a['owner']} | Deadline: {a['deadline']} | Priority: {a['priority']}")
    return "\n".join(parts) if parts else "No notes or action items recorded."
