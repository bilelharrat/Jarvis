# JARVIS 15 Enhanced Features - Integration Guide

This guide explains how the 15 new modular features integrate into JARVIS and how to use them.

## Overview

The 15 features are organized into 3 implementation phases, each with clear APIs for integration:

### Phase 1: Core Document & Communication Stack
- **Features**: Complex documents, calendar editing, context-aware voice-to-text, predictive interrupts, collaboration awareness
- **Modules**: `document.py`, `calendar_smart.py`, `speech_context.py`, `interrupts_predictive.py`, `collab.py`
- **Status**: Ready for integration

### Phase 2: Intelligent Automation & Learning
- **Features**: Decision learning, predictive tasks, media summarization, financial advice
- **Modules**: `decisions_learn.py`, `tasks_predictive.py`, `media_summarize.py`, `finance_banking.py`
- **Status**: Ready for integration

### Phase 3: Advanced Integrations
- **Features**: Real-time call translation, smart home control, autonomous delegation with checkpoints
- **Modules**: `call_translate.py`, `smarthome.py`, `delegate_enhanced.py`
- **Status**: Ready for integration

## Feature Details

### 1. Complex Document Reading & Composition (`document.py`)
**What it does**: Read documents with context preservation, compose structured documents from templates, modify files with precision edits, maintain voice-to-text handoff state.

**Key APIs**:
```python
await handler.read_document(path, preserve_context=True)  # Returns DocumentContext
await handler.compose_document(template, sections, output_path)  # Returns composed content
await handler.modify_file(path, edits)  # Apply TextEdit list
await handler.create_handoff_state(context_snippet, document_target)  # Prepare handoff
```

**Example Usage**:
```
"Jarvis, read my quarterly report and extract the key sections"
→ document.read_document("~/Documents/Q4_Report.md")

"Compose a meeting summary from this template"
→ document.compose_document(template, {"decisions": "...", "actions": "..."})
```

### 2. Direct Calendar Event Editing (`calendar_smart.py`)
**What it does**: Edit calendar events directly, detect conflicts, find optimal meeting times, consolidate multiple calendars.

**Key APIs**:
```python
await calendar.edit_event(EventEdit(...))  # Edit with conflict detection
await calendar.find_optimal_slot(attendees, duration, constraints)  # Find meeting times
await calendar.suggest_calendar_consolidation()  # Consolidation recommendations
```

**Example Usage**:
```
"Move my 2pm meeting to 4pm and check for conflicts"
→ calendar.edit_event(event_id, start_time="4pm")

"Find 1 hour when I, Ann, and Bob are all free this week"
→ calendar.find_optimal_slot(["me", "ann@...", "bob@..."], 60)
```

### 3. Context-Aware Voice-to-Text with Self-Correction (`speech_context.py`)
**What it does**: Transcribe audio with document context, self-correct transcripts, maintain handoff state for seamless continuation.

**Key APIs**:
```python
await speech.transcribe_with_context(audio_bytes, context)  # Contextual transcription
await speech.self_correct_transcript(draft, audio_bytes, context)  # Fix errors
await speech.register_known_entity(entity_type, name, variations)  # Improve accuracy
```

**Example Usage**:
```
"Transcribe this while reading my sales report" (context from doc)
→ speech.transcribe_with_context(audio, SpeechContext(document_context="..."))

"Fix the name 'Jon' to 'John'" (for known entities)
→ speech.register_known_entity("contact", "John", ["Jon", "Jon"])
```

### 4. Direct File Modification (`document.py`)
**What it does**: Apply precise text edits to files (e.g., change line 5 column 10).

**Key APIs**:
```python
await handler.modify_file(path, edits=[TextEdit(line=5, column=10, text="new", old_text="old")])
```

**Example Usage**:
```
"Change line 5 of config.py from DEBUG=True to DEBUG=False"
→ document.modify_file("config.py", [TextEdit(line=5, column=7, old_text="True", text="False")])
```

### 5. Real-Time Collaboration Awareness (`collab.py`)
**What it does**: Detect active collaborators, watch for changes, sync collaboration context, handle merge conflicts.

**Key APIs**:
```python
await collab.detect_active_collaborators(doc_path)  # Who's working on this
await collab.watch_collab_changes(doc_path)  # Async iterator of changes
await collab.sync_collab_context(doc_path)  # Get current state
await collab.broadcast_presence(doc_path, user_id, status)  # Announce yourself
```

**Example Usage**:
```
"Who's editing the Q4 roadmap?"
→ collab.detect_active_collaborators("Q4_roadmap.doc")

"Notify me when others edit this doc"
→ async for event in collab.watch_collab_changes(doc_path): ...
```

### 6. Predictive Interruption Filtering (`interrupts_predictive.py`)
**What it does**: Predict interrupt importance, learn user patterns, recommend actions (allow/queue/dismiss).

**Key APIs**:
```python
await interrupts.predict_interrupt_importance(interrupt)  # Returns ImportanceScore
await interrupts.learn_user_patterns(approved, interrupt_meta)  # Learn from decisions
await interrupts.get_recommended_action(interrupt)  # Action recommendation
await interrupts.set_quiet_hours(start_hour, end_hour)  # Manage quiet times
```

**Example Usage**:
```
(Call from critical contact comes in)
→ interrupts.predict_interrupt_importance(call_interrupt)
→ Returns: CRITICAL level, "allow_immediately"

(User dismisses email notification)
→ interrupts.learn_user_patterns(approved=False, {"type": "email", "from": "spam@..."})
```

### 7. Autonomous Negotiation with Optional Check-ins (`delegate_enhanced.py`)
**What it does**: Create delegations with checkpoint rules, execute autonomously with user approval at defined thresholds.

**Key APIs**:
```python
await delegation.create_delegation_with_checkpoints(
    title, mandate, checkpoint_rules=[...], auto_approve_threshold=0.8
)
await delegation.trigger_checkpoint(delegation_id, checkpoint_type, message)
await delegation.approve_checkpoint(checkpoint_id)  # User approves
await delegation.complete_delegation(delegation_id, result)
```

**Example Usage**:
```
"Negotiate a vendor deal with checkpoints for any offer >$100k"
→ delegation.create_delegation_with_checkpoints(
    "Vendor Negotiation",
    "Negotiate SLA renewal",
    checkpoint_rules=[CheckpointRule(cost_threshold=100000, require_approval=True)]
)

(During execution, if cost exceeds threshold)
→ delegation.trigger_checkpoint(..., "Proposed cost $120k, need approval")
```

### 8. Banking Integration & Financial Advice (`finance_banking.py`)
**What it does**: Connect bank accounts, analyze spending, provide personalized financial advice, track budgets.

**Key APIs**:
```python
await advisor.connect_bank(bank_name, auth_token)  # Connect via Plaid
await advisor.get_advice(question, context)  # Get financial advice
await advisor.analyze_spending_patterns(period_days=30)  # Spending analysis
await advisor.set_budget(category, limit)  # Set category budget
```

**Example Usage**:
```
"How can I save more on groceries?"
→ advisor.get_advice("How can I save more on groceries?")

"Show me my spending breakdown for last month"
→ advisor.analyze_spending_patterns(30)

"Set my coffee budget to $100/month"
→ advisor.set_budget("food_beverages", 100.0)
```

### 9. Multi-Calendar Smart Scheduling (`calendar_smart.py`)
**What it does**: Find optimal meeting times across multiple calendars with constraint handling.

**Key APIs**:
```python
await calendar.find_optimal_slot(
    attendees=["email1", "email2"],
    duration_minutes=60,
    constraints={
        "earliest_time": "09:00",
        "latest_time": "17:00",
        "exclude_weekends": True,
        "next_n_days": 7
    }
)
await calendar.suggest_calendar_consolidation()  # Merge multiple calendars
```

**Example Usage**:
```
"Find best time for all-hands within business hours this week"
→ calendar.find_optimal_slot(all_hands_attendees, 60, constraints={"next_n_days": 7})
```

### 10. Decision-Pattern Learning (`decisions_learn.py`)
**What it does**: Learn from user decisions, identify patterns, predict choices in similar contexts.

**Key APIs**:
```python
await learning.record_decision(context, chosen_option, explanation)
await learning.analyze_patterns()  # Find decision patterns
await learning.predict_choice(similar_context)  # Predict future choices
```

**Example Usage**:
```
(User makes decision about scheduling preference)
→ learning.record_decision(
    context=DecisionContext(domain="scheduling", options=["morning", "afternoon"]),
    chosen_option="morning"
)

"What time would I prefer for future meetings?"
→ learning.predict_choice(DecisionContext(domain="scheduling", ...))
```

### 11. Seamless Voice-to-Text Handoff (`document.py` + `speech_context.py`)
**What it does**: Maintain state across voice-to-text sessions for continuity, preserving context and recent conversation.

**Key APIs**:
```python
state = await handler.create_handoff_state(context_snippet, document_target)
await handler.add_audio_chunk(session_id, audio_chunk)
await handler.update_transcript_draft(session_id, draft_text)
final = await handler.finalize_handoff(session_id, final_transcript)
```

**Example Usage**:
```
User starts voice memo: "I'm writing about..."
→ Create handoff state with document context

User pauses and resumes: "Also important..."
→ Handoff state maintains context across pause

Voice session ends:
→ Finalize and optionally insert into target document
```

### 12. Video Content Summarization (`media_summarize.py`)
**What it does**: Summarize videos from URLs, extract highlights, get transcripts, search cached summaries.

**Key APIs**:
```python
await summarizer.summarize_video_from_url(url)  # Full summary with transcript
await summarizer.extract_video_highlights(url)  # Key moments
await summarizer.get_transcript(url)  # Full transcript
await summarizer.search_summaries(query)  # Search cached videos
```

**Example Usage**:
```
"Summarize this video for me"
→ summarizer.summarize_video_from_url("https://youtube.com/watch?v=...")

"What were the highlights?"
→ summarizer.extract_video_highlights(url)

"Search my video notes for 'machine learning'"
→ summarizer.search_summaries("machine learning")
```

### 13. Real-Time Call Translation (`call_translate.py`)
**What it does**: Translate audio in real-time during calls, inject translated audio, maintain session history.

**Key APIs**:
```python
await translator.create_translation_session(source_language, target_language)
async for segment in translator.translate_call_audio(audio_stream, target_language):
    # Get real-time translation
audio_output = await translator.inject_translated_audio(original, translated_text, language)
```

**Example Usage**:
```
"Translate this call to Spanish in real-time"
→ translator.create_translation_session("en", "es")
→ (call audio streams in and gets translated live)
```

### 14. Predictive Task Suggestions (`tasks_predictive.py`)
**What it does**: Suggest tasks based on calendar events and email patterns, rank by priority, learn from acceptance.

**Key APIs**:
```python
await predictive.suggest_tasks_from_calendar(target_date)
await predictive.suggest_from_emails(inbox_summary)
await predictive.rank_suggestions(suggestions)
await predictive.get_daily_suggestions(target_date)
```

**Example Usage**:
```
"What should I do today?"
→ tasks_predictive.get_daily_suggestions()
→ Returns: ["Prepare for 2pm meeting", "Follow up on action items from emails", ...]

"I'll do the first one"
→ tasks_predictive.record_suggestion_response("Prepare for 2pm meeting", accepted=True)
```

### 15. Direct Smart Home Control (`smarthome.py`)
**What it does**: Discover smart devices, control them directly, create scenes, set up automations.

**Key APIs**:
```python
await home.discover_devices()  # Find all smart devices
await home.control_device(device_id, command, value)  # Direct control
await home.create_scene(name, description, actions)  # Create scene
await home.activate_scene(scene_id)  # Run scene
await home.create_automation(name, trigger, actions)  # Create automation
```

**Example Usage**:
```
"Turn on the living room lights"
→ home.control_device(light_id, "on")

"Create a movie scene that dims lights and closes blinds"
→ home.create_scene("Movie Time", "...", {light_id: {brightness: 10}, blind_id: {position: 0}})

"Set up a morning routine for 7am"
→ home.create_automation("Morning", "time", "07:00", [turn on lights, start coffee, ...])
```

## Integration with Hub

To integrate these modules into JARVIS's `hub.py`, add:

```python
# In hub.py imports
from . import (
    document, calendar_smart, speech_context, interrupts_predictive, collab,
    decisions_learn, tasks_predictive, media_summarize, finance_banking,
    call_translate, smarthome, delegate_enhanced
)

# In build_options() MCP server registration
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
```

## Testing

Each module includes:
- Clean API contracts
- Mock implementations for development
- Persistent storage (JSON files)
- Full error handling

To test individual features:

```bash
# Test document handling
uv run python -c "from jarvis.document import DocumentHandler; ..."

# Test calendar intelligence
uv run python -c "from jarvis.calendar_smart import CalendarIntelligence; ..."

# Run existing test suite
uv run python -m pytest tests/
```

## Permissions & Safety

- **Read-only tools** (detect, analyze, summarize): Auto-allow after first use
- **Write tools** (control, modify, execute): Require user approval
- **External APIs** (banking, translation): Gated by settings, tokens in Keychain
- **Automation** (delegation, scheduling): Checkpoint rules ensure user control

## Performance Considerations

- **Document reading**: Cached after first read (hash-based invalidation)
- **Collaboration watching**: Async streams with 300-second timeout per chunk
- **Predictions**: Lightweight heuristics; ML models optional
- **Video summaries**: Cached locally, TTL-based refresh
- **Call translation**: Real-time processing; consider local Whisper + cloud translation

## Future Enhancements

1. **ML Models**: Deploy lightweight decision/task prediction models
2. **External APIs**: Wire up Plaid (banking), ElevenLabs (TTS), Cloud Translation
3. **Multi-user**: Extend collaboration tracking to shared contexts
4. **Analytics**: Dashboard of decision patterns, spending trends, task effectiveness
5. **Voice Profiles**: Learn individual speech patterns for better transcription

## Support & Issues

- All modules include docstrings and type hints
- See individual module files for detailed implementation notes
- Report issues with specific feature + reproduction steps
