"""
SmartInterrupts Module: Predictive interruption filtering and importance scoring.

Provides APIs for:
- Predicting interrupt importance
- Learning user patterns
- Recommending interrupt actions
- Smart filtering of notifications
"""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime
from enum import Enum
import json
from pathlib import Path


class InterruptType(Enum):
    """Types of interrupts."""
    CALL = "call"
    MESSAGE = "message"
    NOTIFICATION = "notification"
    MEETING_START = "meeting_start"
    EMAIL = "email"
    REMINDER = "reminder"
    ALERT = "alert"


class ImportanceLevel(Enum):
    """Importance levels."""
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    IGNORE = "ignore"


@dataclass
class Interrupt:
    """Represents an interruption event."""
    interrupt_type: InterruptType
    source: str  # caller name, app name, etc.
    message: Optional[str] = None
    timestamp: str = ""
    metadata: dict = field(default_factory=dict)
    context: Optional[dict] = None  # What user was doing


@dataclass
class ImportanceScore:
    """Scoring of interrupt importance."""
    interrupt_id: str
    level: ImportanceLevel
    confidence: float  # 0.0-1.0
    factors: dict = field(default_factory=dict)  # What influenced the score
    recommendation: Optional[str] = None


@dataclass
class RecommendedAction:
    """Recommended action for an interrupt."""
    action: str  # "allow", "queue", "dismiss", "escalate"
    reason: str
    priority: int  # 1-5


class SmartInterrupts:
    """Predictive interrupt management."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/.jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.patterns_file = self.storage_path / "interrupt_patterns.json"
        self.learning_data: List[dict] = []
        self.user_preferences: dict = {}
        self._load_patterns()
    
    def _load_patterns(self) -> None:
        """Load learned patterns from disk."""
        if self.patterns_file.exists():
            try:
                with open(self.patterns_file) as f:
                    data = json.load(f)
                    self.learning_data = data.get("history", [])
                    self.user_preferences = data.get("preferences", {})
            except (json.JSONDecodeError, TypeError):
                pass
    
    def _save_patterns(self) -> None:
        """Persist patterns to disk."""
        data = {
            "history": self.learning_data[-1000:],  # Keep last 1000
            "preferences": self.user_preferences,
            "timestamp": datetime.now().isoformat()
        }
        with open(self.patterns_file, 'w') as f:
            json.dump(data, f, indent=2)
    
    async def predict_interrupt_importance(self, interrupt: Interrupt) -> ImportanceScore:
        """
        Predict the importance of an interrupt.
        
        Args:
            interrupt: The interrupt event
            
        Returns:
            ImportanceScore with reasoning
        """
        factors = {}
        score = 0.5  # Base score
        
        # Check if source is in critical contacts
        critical_contacts = self.user_preferences.get("critical_contacts", [])
        if interrupt.source in critical_contacts:
            score += 0.3
            factors["in_critical_contacts"] = True
        
        # Check interrupt type
        type_weights = {
            InterruptType.CALL: 0.8,
            InterruptType.MESSAGE: 0.6,
            InterruptType.EMAIL: 0.4,
            InterruptType.NOTIFICATION: 0.3,
            InterruptType.MEETING_START: 0.9,
            InterruptType.ALERT: 0.7,
            InterruptType.REMINDER: 0.2,
        }
        
        type_weight = type_weights.get(interrupt.interrupt_type, 0.4)
        score = min(1.0, score + (type_weight - 0.5) * 0.3)
        factors["type_weight"] = type_weight
        
        # Check if user is in a meeting
        if interrupt.context and interrupt.context.get("in_meeting"):
            score *= 0.7  # Reduce importance during meetings
            factors["in_meeting"] = True
        
        # Check time (reduce importance during quiet hours)
        hour = datetime.now().hour
        quiet_hours = self.user_preferences.get("quiet_hours", {"start": 21, "end": 8})
        if quiet_hours["start"] > quiet_hours["end"]:
            # Wraps midnight
            if hour >= quiet_hours["start"] or hour < quiet_hours["end"]:
                score *= 0.5
                factors["quiet_hours"] = True
        
        # Determine level
        if score >= 0.8:
            level = ImportanceLevel.CRITICAL
        elif score >= 0.6:
            level = ImportanceLevel.HIGH
        elif score >= 0.4:
            level = ImportanceLevel.MEDIUM
        elif score >= 0.2:
            level = ImportanceLevel.LOW
        else:
            level = ImportanceLevel.IGNORE
        
        recommendation = self._get_recommendation(level, interrupt)
        
        return ImportanceScore(
            interrupt_id=interrupt.timestamp + "_" + interrupt.source,
            level=level,
            confidence=0.85,
            factors=factors,
            recommendation=recommendation
        )
    
    def _get_recommendation(self, level: ImportanceLevel, interrupt: Interrupt) -> str:
        """Get recommendation for handling interrupt."""
        if level == ImportanceLevel.CRITICAL:
            return "allow_immediately"
        elif level == ImportanceLevel.HIGH:
            return "notify_with_preview"
        elif level == ImportanceLevel.MEDIUM:
            return "queue_for_later"
        elif level == ImportanceLevel.LOW:
            return "silent_notification"
        else:
            return "silently_ignore"
    
    async def learn_user_patterns(
        self,
        approved: bool,
        interrupt_meta: dict
    ) -> None:
        """
        Learn from user's interrupt handling decisions.
        
        Args:
            approved: Whether user approved this interrupt
            interrupt_meta: Metadata about the interrupt
        """
        learning_entry = {
            "timestamp": datetime.now().isoformat(),
            "approved": approved,
            "interrupt": interrupt_meta,
            "context": interrupt_meta.get("context", {})
        }
        
        self.learning_data.append(learning_entry)
        
        # Update preferences based on patterns
        source = interrupt_meta.get("source", "unknown")
        if approved:
            # Increase importance for this source
            critical = self.user_preferences.get("critical_contacts", [])
            if source not in critical:
                critical.append(source)
            self.user_preferences["critical_contacts"] = critical
        
        # Periodically save
        if len(self.learning_data) % 10 == 0:
            self._save_patterns()
    
    async def get_recommended_action(self, interrupt: Interrupt) -> RecommendedAction:
        """
        Get recommended action for an interrupt.
        
        Args:
            interrupt: The interrupt event
            
        Returns:
            RecommendedAction with reasoning
        """
        importance = await self.predict_interrupt_importance(interrupt)
        
        action_map = {
            ImportanceLevel.CRITICAL: ("allow", "This is critical and time-sensitive", 1),
            ImportanceLevel.HIGH: ("notify_with_preview", "Important but can wait for a moment", 2),
            ImportanceLevel.MEDIUM: ("queue", "Can be handled when you're free", 3),
            ImportanceLevel.LOW: ("silent", "Low priority, logged for later", 4),
            ImportanceLevel.IGNORE: ("dismiss", "Not important right now", 5),
        }
        
        action, reason, priority = action_map.get(importance.level, ("queue", "Default handling", 3))
        
        return RecommendedAction(
            action=action,
            reason=reason,
            priority=priority
        )
    
    async def filter_interrupts(self, interrupts: List[Interrupt]) -> dict:
        """
        Filter and prioritize a batch of interrupts.
        
        Args:
            interrupts: List of interrupts to filter
            
        Returns:
            Dict with filtered, prioritized lists
        """
        scored = []
        
        for interrupt in interrupts:
            score = await self.predict_interrupt_importance(interrupt)
            action = await self.get_recommended_action(interrupt)
            scored.append({
                "interrupt": interrupt,
                "score": score,
                "action": action
            })
        
        # Sort by importance
        scored.sort(key=lambda x: self._level_to_num(x["score"].level), reverse=True)
        
        return {
            "all": scored,
            "critical": [s for s in scored if s["score"].level == ImportanceLevel.CRITICAL],
            "high": [s for s in scored if s["score"].level == ImportanceLevel.HIGH],
            "medium": [s for s in scored if s["score"].level == ImportanceLevel.MEDIUM],
            "low": [s for s in scored if s["score"].level in [ImportanceLevel.LOW, ImportanceLevel.IGNORE]]
        }
    
    def _level_to_num(self, level: ImportanceLevel) -> int:
        """Convert ImportanceLevel to number for sorting."""
        mapping = {
            ImportanceLevel.CRITICAL: 5,
            ImportanceLevel.HIGH: 4,
            ImportanceLevel.MEDIUM: 3,
            ImportanceLevel.LOW: 2,
            ImportanceLevel.IGNORE: 1
        }
        return mapping.get(level, 0)
    
    async def set_quiet_hours(self, start_hour: int, end_hour: int) -> None:
        """Set quiet hours for interrupts."""
        self.user_preferences["quiet_hours"] = {"start": start_hour, "end": end_hour}
        self._save_patterns()
    
    async def add_critical_contact(self, contact_name: str) -> None:
        """Mark a contact as critical (always allow)."""
        critical = self.user_preferences.get("critical_contacts", [])
        if contact_name not in critical:
            critical.append(contact_name)
        self.user_preferences["critical_contacts"] = critical
        self._save_patterns()


# MCP Server builder
def build_server():
    """Build MCP server for SmartInterrupts."""
    
    smart_interrupts = SmartInterrupts()
    
    class SmartInterruptsServer:
        """MCP server for interrupt management."""
        
        def __init__(self):
            self.interrupts = smart_interrupts
        
        async def predict_importance(self, interrupt: dict) -> dict:
            """Predict interrupt importance."""
            intr = Interrupt(
                interrupt_type=InterruptType[interrupt["type"].upper()],
                source=interrupt["source"],
                message=interrupt.get("message"),
                timestamp=interrupt.get("timestamp", datetime.now().isoformat()),
                metadata=interrupt.get("metadata", {})
            )
            score = await self.interrupts.predict_interrupt_importance(intr)
            return {
                "level": score.level.value,
                "confidence": score.confidence,
                "factors": score.factors,
                "recommendation": score.recommendation
            }
        
        async def learn_pattern(self, approved: bool, interrupt_meta: dict) -> dict:
            """Learn from user decision."""
            await self.interrupts.learn_user_patterns(approved, interrupt_meta)
            return {"success": True, "learned": True}
        
        async def get_action(self, interrupt: dict) -> dict:
            """Get recommended action."""
            intr = Interrupt(
                interrupt_type=InterruptType[interrupt["type"].upper()],
                source=interrupt["source"],
                message=interrupt.get("message"),
                timestamp=interrupt.get("timestamp", datetime.now().isoformat())
            )
            action = await self.interrupts.get_recommended_action(intr)
            return {
                "action": action.action,
                "reason": action.reason,
                "priority": action.priority
            }
        
        async def set_quiet_hours(self, start_hour: int, end_hour: int) -> dict:
            """Set quiet hours."""
            await self.interrupts.set_quiet_hours(start_hour, end_hour)
            return {"success": True}
        
        async def add_critical_contact(self, contact_name: str) -> dict:
            """Add critical contact."""
            await self.interrupts.add_critical_contact(contact_name)
            return {"success": True, "contact": contact_name}
    
    return SmartInterruptsServer()
