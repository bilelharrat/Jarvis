"""
Enhanced Features Module Initialization

Centralizes all 15 enhanced feature modules for easy integration with hub.py
"""

from . import (
    document,
    calendar_smart,
    speech_context,
    interrupts_predictive,
    collab,
    decisions_learn,
    tasks_predictive,
    media_summarize,
    finance_banking,
    call_translate,
    smarthome,
    delegate_enhanced,
)

__all__ = [
    "document",
    "calendar_smart",
    "speech_context",
    "interrupts_predictive",
    "collab",
    "decisions_learn",
    "tasks_predictive",
    "media_summarize",
    "finance_banking",
    "call_translate",
    "smarthome",
    "delegate_enhanced",
]


def build_all_servers():
    """Build all MCP servers for the enhanced features.
    
    Returns:
        List of MCP server instances ready for integration into hub.py
    """
    servers = [
        document.build_server(),
        calendar_smart.build_server(),
        speech_context.build_server(),
        interrupts_predictive.build_server(),
        collab.build_server(),
        decisions_learn.build_server(),
        tasks_predictive.build_server(),
        media_summarize.build_server(),
        finance_banking.build_server(),
        call_translate.build_server(),
        smarthome.build_server(),
        delegate_enhanced.build_server(),
    ]
    return servers


def get_feature_summary():
    """Get summary of all available features.
    
    Returns:
        Dict with feature information for help/docs
    """
    return {
        "total_features": 15,
        "total_modules": 12,
        "features": {
            "document": {
                "module": "document.py",
                "features": ["Complex document reading", "Composition", "File editing", "Voice-to-text handoff"],
                "apis": ["read_document", "compose_document", "modify_file", "create_handoff_state"]
            },
            "calendar": {
                "module": "calendar_smart.py",
                "features": ["Direct event editing", "Conflict detection", "Optimal scheduling"],
                "apis": ["edit_event", "find_optimal_slot", "check_conflicts"]
            },
            "speech": {
                "module": "speech_context.py",
                "features": ["Context-aware transcription", "Self-correction", "Known entity registration"],
                "apis": ["transcribe_with_context", "self_correct_transcript", "register_known_entity"]
            },
            "collaboration": {
                "module": "collab.py",
                "features": ["Active collaborator detection", "Change watching", "Conflict handling"],
                "apis": ["detect_active_collaborators", "watch_collab_changes", "broadcast_presence"]
            },
            "interrupts": {
                "module": "interrupts_predictive.py",
                "features": ["Importance prediction", "Pattern learning", "Smart filtering"],
                "apis": ["predict_interrupt_importance", "learn_user_patterns", "get_recommended_action"]
            },
            "decisions": {
                "module": "decisions_learn.py",
                "features": ["Decision recording", "Pattern analysis", "Choice prediction"],
                "apis": ["record_decision", "analyze_patterns", "predict_choice"]
            },
            "tasks": {
                "module": "tasks_predictive.py",
                "features": ["Calendar-based suggestions", "Email-based suggestions", "Ranking"],
                "apis": ["suggest_tasks_from_calendar", "suggest_from_emails", "get_daily_suggestions"]
            },
            "media": {
                "module": "media_summarize.py",
                "features": ["Video summarization", "Highlight extraction", "Transcript management"],
                "apis": ["summarize_video_from_url", "extract_video_highlights", "search_summaries"]
            },
            "finance": {
                "module": "finance_banking.py",
                "features": ["Bank connection", "Spending analysis", "Financial advice", "Budget tracking"],
                "apis": ["connect_bank", "get_advice", "analyze_spending_patterns", "set_budget"]
            },
            "translation": {
                "module": "call_translate.py",
                "features": ["Language detection", "Real-time translation", "Audio injection"],
                "apis": ["detect_language", "translate_call_audio", "create_translation_session"]
            },
            "smarthome": {
                "module": "smarthome.py",
                "features": ["Device discovery", "Direct control", "Scene creation", "Automation"],
                "apis": ["discover_devices", "control_device", "create_scene", "activate_scene"]
            },
            "delegation": {
                "module": "delegate_enhanced.py",
                "features": ["Checkpoint-based delegation", "Autonomous execution", "Approval flow"],
                "apis": ["create_delegation_with_checkpoints", "trigger_checkpoint", "approve_checkpoint"]
            }
        }
    }
