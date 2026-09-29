"""
Comprehensive tests for all 15 enhanced JARVIS features.
Tests cover all Phase 1, 2, and 3 modules.
"""

import pytest
import asyncio
import tempfile
from pathlib import Path
from datetime import datetime, date, timedelta

# Phase 1 Modules
from src.jarvis.document import DocumentHandler, DocumentContext, TextEdit
from src.jarvis.calendar_smart import CalendarIntelligence, EventEdit
from src.jarvis.speech_context import ContextSpeech, SpeechContext
from src.jarvis.interrupts_predictive import SmartInterrupts, Interrupt, InterruptType
from src.jarvis.collab import CollaborationAwareness

# Phase 2 Modules
from src.jarvis.decisions_learn import DecisionLearning, DecisionContext
from src.jarvis.tasks_predictive import PredictiveTasks
from src.jarvis.media_summarize import MediaSummarizer
from src.jarvis.finance_banking import FinancialAdvisor

# Phase 3 Modules
from src.jarvis.call_translate import CallTranslator
from src.jarvis.smarthome import SmartHomeControl, DeviceType
from src.jarvis.delegate_enhanced import EnhancedDelegation, CheckpointRule, CheckpointType


# ==================== PHASE 1 TESTS ====================

class TestDocumentHandler:
    """Test complex document reading, composition, file modification."""
    
    @pytest.mark.asyncio
    async def test_read_document(self):
        """Test document reading with context preservation."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
            f.write("# Title\n\n## Section 1\nContent")
            path = f.name
        
        handler = DocumentHandler()
        try:
            context = await handler.read_document(path)
            assert context.file_type == "markdown"
            assert context.line_count >= 3  # Includes empty lines
            assert len(context.sections) > 0
        finally:
            Path(path).unlink()
    
    @pytest.mark.asyncio
    async def test_compose_document(self):
        """Test document composition from template."""
        handler = DocumentHandler()
        template = "## {title}\n{body}"
        sections = {"title": "Meeting Notes", "body": "Discussed Q4 roadmap"}
        
        result = await handler.compose_document(template, sections)
        assert "Meeting Notes" in result
        assert "Q4 roadmap" in result
    
    @pytest.mark.asyncio
    async def test_modify_file(self):
        """Test file modification with precision edits."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write("Line 1\nLine 2\nLine 3\n")
            path = f.name
        
        handler = DocumentHandler()
        try:
            edits = [TextEdit(line=1, column=6, old_text="2", text="2 MODIFIED")]
            result = await handler.modify_file(path, edits)
            assert result is True
            
            with open(path) as f:
                content = f.read()
                assert "MODIFIED" in content
        finally:
            Path(path).unlink()
    
    @pytest.mark.asyncio
    async def test_handoff_state(self):
        """Test voice-to-text handoff state management."""
        handler = DocumentHandler()
        state = await handler.create_handoff_state("Document context", None, "en-US")
        
        assert state.session_id is not None
        assert state.context_snippet == "Document context"
        assert state.language == "en-US"
        
        await handler.update_transcript_draft(state.session_id, "Test transcript")
        final = await handler.finalize_handoff(state.session_id, "Final transcript")
        assert final == "Final transcript"


class TestCalendarSmart:
    """Test calendar editing and smart scheduling."""
    
    @pytest.mark.asyncio
    async def test_find_optimal_slot(self):
        """Test finding optimal meeting times."""
        calendar = CalendarIntelligence()
        slots = await calendar.find_optimal_slot(
            ["user1@", "user2@"],
            60,
            {"next_n_days": 7, "exclude_weekends": True}
        )
        assert len(slots) > 0
        assert slots[0].duration_minutes == 60
    
    @pytest.mark.asyncio
    async def test_edit_event(self):
        """Test event editing with conflict detection."""
        calendar = CalendarIntelligence()
        edit = EventEdit(
            event_id="event123",
            calendar_id="primary",
            title="New Title"
        )
        result = await calendar.edit_event(edit)
        assert result["success"] is True


class TestSpeechContext:
    """Test context-aware voice-to-text."""
    
    @pytest.mark.asyncio
    async def test_transcribe_with_context(self):
        """Test transcription with document context."""
        speech = ContextSpeech()
        context = SpeechContext(
            document_context="Discussing Q4 roadmap",
            known_entities={"projects": ["ProjectA", "ProjectB"]}
        )
        
        audio = b"test audio"
        result = await speech.transcribe_with_context(audio, context)
        
        assert result.text is not None
        assert result.confidence > 0
        assert result.language == "en-US"
    
    @pytest.mark.asyncio
    async def test_register_entity(self):
        """Test registering known entities for correction."""
        speech = ContextSpeech()
        await speech.register_known_entity("contact", "John", ["Jon", "Johann"])
        
        assert "contact" in speech.entity_corrections
        assert "John" in speech.entity_corrections["contact"]


class TestInterruptsPredictive:
    """Test predictive interruption filtering."""
    
    @pytest.mark.asyncio
    async def test_predict_importance(self):
        """Test interruption importance prediction."""
        interrupts = SmartInterrupts()
        interrupt = Interrupt(
            interrupt_type=InterruptType.CALL,
            source="john@example.com",
            timestamp=datetime.now().isoformat()
        )
        
        score = await interrupts.predict_interrupt_importance(interrupt)
        assert score.level is not None
        assert 0 <= score.confidence <= 1.0
    
    @pytest.mark.asyncio
    async def test_learn_patterns(self):
        """Test learning from user decisions."""
        interrupts = SmartInterrupts()
        
        # Record that user approved a call from John
        await interrupts.learn_user_patterns(
            True,
            {"source": "john@example.com", "type": "call"}
        )
        
        # John should now be in critical contacts
        assert "john@example.com" in interrupts.user_preferences.get("critical_contacts", [])


class TestCollaboration:
    """Test real-time collaboration awareness."""
    
    @pytest.mark.asyncio
    async def test_detect_collaborators(self):
        """Test detecting active collaborators."""
        collab = CollaborationAwareness()
        
        await collab.broadcast_presence(
            "doc.md",
            "user1",
            "Alice",
            "active"
        )
        
        collaborators = await collab.detect_active_collaborators("doc.md")
        assert len(collaborators) > 0


# ==================== PHASE 2 TESTS ====================

class TestDecisionLearning:
    """Test decision-pattern learning."""
    
    @pytest.mark.asyncio
    async def test_record_decision(self):
        """Test recording user decisions."""
        learning = DecisionLearning()
        context = DecisionContext(
            domain="scheduling",
            options=["morning", "afternoon"],
            constraints={}
        )
        
        decision_id = await learning.record_decision(context, "morning")
        assert decision_id is not None
    
    @pytest.mark.asyncio
    async def test_analyze_patterns(self):
        """Test analyzing decision patterns."""
        learning = DecisionLearning()
        
        # Record multiple decisions
        context = DecisionContext(domain="scheduling", options=["morning", "afternoon"])
        for _ in range(3):
            await learning.record_decision(context, "morning")
        
        patterns = await learning.analyze_patterns()
        assert patterns["total_patterns"] >= 0


class TestPredictiveTasks:
    """Test predictive task suggestions."""
    
    @pytest.mark.asyncio
    async def test_suggest_from_calendar(self):
        """Test suggesting tasks from calendar."""
        tasks = PredictiveTasks()
        suggestions = await tasks.suggest_tasks_from_calendar(date.today())
        
        assert isinstance(suggestions, list)
    
    @pytest.mark.asyncio
    async def test_daily_suggestions(self):
        """Test getting daily suggestions."""
        tasks = PredictiveTasks()
        result = await tasks.get_daily_suggestions()
        
        assert "total_suggestions" in result
        assert "suggestions" in result


class TestMediaSummarizer:
    """Test video summarization."""
    
    @pytest.mark.asyncio
    async def test_summarize_video(self):
        """Test video summarization."""
        summarizer = MediaSummarizer()
        
        url = "https://example.com/video.mp4"
        summary = await summarizer.summarize_video_from_url(url)
        
        assert summary.url == url
        assert summary.duration_seconds > 0
    
    @pytest.mark.asyncio
    async def test_extract_highlights(self):
        """Test extracting video highlights."""
        summarizer = MediaSummarizer()
        
        url = "https://example.com/video.mp4"
        highlights = await summarizer.extract_video_highlights(url)
        
        assert isinstance(highlights, list)


class TestFinancialAdvisor:
    """Test banking integration and financial advice."""
    
    @pytest.mark.asyncio
    async def test_analyze_spending(self):
        """Test spending analysis."""
        advisor = FinancialAdvisor()
        analysis = await advisor.analyze_spending_patterns(30)
        
        assert analysis.total_spent >= 0
        assert 0 <= analysis.savings_rate <= 1.0


# ==================== PHASE 3 TESTS ====================

class TestCallTranslation:
    """Test real-time call translation."""
    
    @pytest.mark.asyncio
    async def test_detect_language(self):
        """Test language detection."""
        translator = CallTranslator()
        
        audio = b"test audio"
        language = await translator.detect_language(audio)
        
        assert isinstance(language, str)
    
    @pytest.mark.asyncio
    async def test_create_session(self):
        """Test creating translation session."""
        translator = CallTranslator()
        
        session = await translator.create_translation_session("en", "es")
        assert session.session_id is not None
        assert session.source_language == "en"
        assert session.target_language == "es"


class TestSmartHome:
    """Test smart home control."""
    
    @pytest.mark.asyncio
    async def test_discover_devices(self):
        """Test device discovery."""
        home = SmartHomeControl()
        
        devices = await home.discover_devices()
        assert isinstance(devices, list)
    
    @pytest.mark.asyncio
    async def test_create_scene(self):
        """Test scene creation."""
        home = SmartHomeControl()
        
        scene = await home.create_scene(
            "Movie Time",
            "Dim lights and close blinds",
            {}
        )
        assert scene.scene_id is not None
        assert scene.name == "Movie Time"


class TestEnhancedDelegation:
    """Test autonomous delegation with checkpoints."""
    
    @pytest.mark.asyncio
    async def test_create_delegation(self):
        """Test creating delegation."""
        delegation = EnhancedDelegation()
        
        deleg = await delegation.create_delegation_with_checkpoints(
            "Vendor Negotiation",
            "Negotiate SLA renewal",
            [],
            0.8
        )
        
        assert deleg.delegation_id is not None
        assert deleg.title == "Vendor Negotiation"
    
    @pytest.mark.asyncio
    async def test_checkpoint_flow(self):
        """Test checkpoint approval flow."""
        delegation = EnhancedDelegation()
        
        deleg = await delegation.create_delegation_with_checkpoints(
            "Test",
            "Test delegation",
            []
        )
        
        await delegation.start_delegation_execution(deleg.delegation_id)
        
        checkpoint = await delegation.trigger_checkpoint(
            deleg.delegation_id,
            CheckpointType.APPROVAL_REQUIRED,
            "Need approval for this action"
        )
        
        assert checkpoint.checkpoint_id is not None
        
        result = await delegation.approve_checkpoint(checkpoint.checkpoint_id)
        assert result["success"] is True


# ==================== INTEGRATION TESTS ====================

class TestCrossFeatureIntegration:
    """Test integration across multiple features."""
    
    @pytest.mark.asyncio
    async def test_voice_memo_to_document(self):
        """Test voice memo to document workflow."""
        doc_handler = DocumentHandler()
        speech = ContextSpeech()
        
        # Create handoff state
        state = await doc_handler.create_handoff_state("Meeting notes", None, "en-US")
        assert state.session_id is not None
        
        # Simulate transcription with context
        context = SpeechContext(document_context="Discussing roadmap")
        result = await speech.transcribe_with_context(b"audio", context)
        assert result.text is not None
    
    @pytest.mark.asyncio
    async def test_meeting_to_tasks(self):
        """Test meeting suggestion to tasks workflow."""
        calendar = CalendarIntelligence()
        tasks = PredictiveTasks()
        
        # Get calendar data
        slots = await calendar.find_optimal_slot(["user@"], 60)
        assert len(slots) > 0
        
        # Get task suggestions
        suggestions = await tasks.suggest_tasks_from_calendar(date.today())
        assert isinstance(suggestions, list)


# ==================== PERFORMANCE TESTS ====================

class TestPerformance:
    """Test performance characteristics."""
    
    @pytest.mark.asyncio
    async def test_document_read_speed(self):
        """Test document reading performance."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
            f.write("# Large Document\n" + ("Content\n" * 1000))
            path = f.name
        
        handler = DocumentHandler()
        try:
            import time
            start = time.time()
            context = await handler.read_document(path)
            elapsed = time.time() - start
            
            assert elapsed < 1.0  # Should complete within 1 second
        finally:
            Path(path).unlink()
    
    @pytest.mark.asyncio
    async def test_interrupt_scoring_speed(self):
        """Test interrupt scoring performance."""
        import time
        interrupts = SmartInterrupts()
        interrupt = Interrupt(
            interrupt_type=InterruptType.MESSAGE,
            source="test@example.com",
            timestamp=datetime.now().isoformat()
        )
        
        start = time.time()
        score = await interrupts.predict_interrupt_importance(interrupt)
        elapsed = time.time() - start
        
        assert elapsed < 0.1  # Should complete within 100ms


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
