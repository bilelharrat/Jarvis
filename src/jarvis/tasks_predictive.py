"""
PredictiveTasks Module: Suggest tasks based on calendar and email patterns.

Provides APIs for:
- Suggesting tasks from calendar events
- Suggesting tasks from emails
- Ranking suggestions by priority
"""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime, date
from enum import Enum


class TaskPriority(Enum):
    """Task priority levels."""
    CRITICAL = 5
    HIGH = 4
    MEDIUM = 3
    LOW = 2
    MINIMAL = 1


@dataclass
class TaskSuggestion:
    """A suggested task."""
    title: str
    description: str
    source: str  # "calendar", "email", "pattern"
    source_id: Optional[str] = None
    priority: TaskPriority = TaskPriority.MEDIUM
    suggested_due: Optional[str] = None  # ISO date
    estimated_duration_minutes: int = 30
    context: dict = field(default_factory=dict)
    confidence: float = 0.7  # 0.0-1.0
    related_events: List[str] = field(default_factory=list)


class PredictiveTasks:
    """Predictive task suggestion engine."""
    
    def __init__(self):
        self.suggestion_history: List[TaskSuggestion] = []
        self.accepted_tasks: set[str] = set()
        self.rejected_tasks: set[str] = set()
    
    async def suggest_tasks_from_calendar(
        self,
        target_date: date
    ) -> List[TaskSuggestion]:
        """
        Suggest tasks based on calendar for a specific date.
        
        Args:
            target_date: Date to suggest tasks for
            
        Returns:
            List of TaskSuggestion objects
        """
        suggestions = []
        
        # Example patterns:
        # - Friday meeting prep task before Monday meeting
        # - Prep task before presentation
        # - Follow-up task after meeting
        # - Travel prep tasks before travel
        
        # In production, this would analyze actual calendar events
        # For now, return example suggestions
        
        # Task before meetings
        suggestions.append(TaskSuggestion(
            title="Prepare meeting materials",
            description="Review agenda and prepare talking points",
            source="calendar",
            priority=TaskPriority.HIGH,
            suggested_due=target_date.isoformat(),
            estimated_duration_minutes=45,
            confidence=0.8,
            context={"meeting_type": "standup"}
        ))
        
        # End-of-day review task
        if target_date.weekday() == 4:  # Friday
            suggestions.append(TaskSuggestion(
                title="Weekly review and planning",
                description="Review completed tasks and plan next week",
                source="calendar",
                priority=TaskPriority.MEDIUM,
                suggested_due=target_date.isoformat(),
                estimated_duration_minutes=30,
                confidence=0.9
            ))
        
        return suggestions
    
    async def suggest_from_emails(
        self,
        inbox_summary: str
    ) -> List[TaskSuggestion]:
        """
        Suggest tasks based on email content.
        
        Args:
            inbox_summary: Summary of recent emails
            
        Returns:
            List of TaskSuggestion objects
        """
        suggestions = []
        
        # Patterns to look for in emails:
        # - "Action item:" or "TODO:"
        # - "Can you..." / "Would you..." (requests)
        # - Deadline mentions
        # - Project-related keywords
        
        # Example: Extract action items from email content
        action_indicators = ["action item", "todo", "fyi - action", "task", "due"]
        
        for indicator in action_indicators:
            if indicator.lower() in inbox_summary.lower():
                suggestions.append(TaskSuggestion(
                    title="Follow up on email action items",
                    description=f"Review emails containing '{indicator}'",
                    source="email",
                    priority=TaskPriority.HIGH,
                    estimated_duration_minutes=20,
                    confidence=0.8,
                    context={"email_indicator": indicator}
                ))
                break  # Only suggest once
        
        # Look for deadline mentions
        deadline_keywords = ["deadline", "due date", "by end of", "asap", "urgent"]
        for keyword in deadline_keywords:
            if keyword.lower() in inbox_summary.lower():
                suggestions.append(TaskSuggestion(
                    title="Handle urgent/deadline items from email",
                    description="Review and prioritize deadline-related emails",
                    source="email",
                    priority=TaskPriority.CRITICAL,
                    estimated_duration_minutes=30,
                    confidence=0.85,
                    context={"deadline_keyword": keyword}
                ))
                break
        
        return suggestions
    
    async def rank_suggestions(
        self,
        suggestions: List[TaskSuggestion]
    ) -> List[TaskSuggestion]:
        """
        Rank suggestions by priority and confidence.
        
        Args:
            suggestions: List of suggestions to rank
            
        Returns:
            Ranked list of suggestions
        """
        # Calculate composite score
        def score(task: TaskSuggestion) -> float:
            priority_score = task.priority.value / 5.0  # Normalize to 0-1
            confidence_score = task.confidence
            composite = (priority_score * 0.6) + (confidence_score * 0.4)
            return composite
        
        ranked = sorted(suggestions, key=score, reverse=True)
        return ranked
    
    async def get_daily_suggestions(
        self,
        target_date: Optional[date] = None
    ) -> dict:
        """
        Get all task suggestions for a day.
        
        Args:
            target_date: Date to get suggestions for (default: today)
            
        Returns:
            Dict with categorized suggestions
        """
        if target_date is None:
            target_date = date.today()
        
        calendar_tasks = await self.suggest_tasks_from_calendar(target_date)
        email_tasks = []  # Would need actual email summary
        
        all_tasks = calendar_tasks + email_tasks
        ranked = await self.rank_suggestions(all_tasks)
        
        return {
            "date": target_date.isoformat(),
            "total_suggestions": len(ranked),
            "critical": len([t for t in ranked if t.priority == TaskPriority.CRITICAL]),
            "high": len([t for t in ranked if t.priority == TaskPriority.HIGH]),
            "suggestions": [
                {
                    "title": t.title,
                    "priority": t.priority.name,
                    "estimated_duration": t.estimated_duration_minutes,
                    "confidence": t.confidence,
                    "source": t.source
                }
                for t in ranked
            ]
        }
    
    async def record_suggestion_response(
        self,
        task_title: str,
        accepted: bool
    ) -> None:
        """
        Learn from user accepting or rejecting suggestions.
        
        Args:
            task_title: Title of suggested task
            accepted: Whether user accepted
        """
        if accepted:
            self.accepted_tasks.add(task_title)
        else:
            self.rejected_tasks.add(task_title)
    
    async def get_suggestion_effectiveness(self) -> dict:
        """
        Get metrics on suggestion quality.
        
        Returns:
            Effectiveness metrics
        """
        total = len(self.accepted_tasks) + len(self.rejected_tasks)
        if total == 0:
            return {"status": "no_feedback"}
        
        acceptance_rate = len(self.accepted_tasks) / total
        
        return {
            "total_suggestions": total,
            "accepted": len(self.accepted_tasks),
            "rejected": len(self.rejected_tasks),
            "acceptance_rate": acceptance_rate,
            "status": "good" if acceptance_rate >= 0.6 else "needs_improvement"
        }


# MCP Server builder
def build_server():
    """Build MCP server for PredictiveTasks."""
    
    predictive = PredictiveTasks()
    
    class PredictiveTasksServer:
        """MCP server for task predictions."""
        
        def __init__(self):
            self.predictive = predictive
        
        async def suggest_from_calendar(self, target_date: str) -> dict:
            """Suggest tasks from calendar."""
            from datetime import datetime as dt
            date_obj = dt.fromisoformat(target_date).date()
            tasks = await self.predictive.suggest_tasks_from_calendar(date_obj)
            return {
                "date": target_date,
                "suggestions": [
                    {
                        "title": t.title,
                        "description": t.description,
                        "priority": t.priority.name,
                        "estimated_duration": t.estimated_duration_minutes,
                        "confidence": t.confidence
                    }
                    for t in tasks
                ]
            }
        
        async def suggest_from_emails(self, inbox_summary: str) -> dict:
            """Suggest tasks from emails."""
            tasks = await self.predictive.suggest_from_emails(inbox_summary)
            return {
                "suggestions": [
                    {
                        "title": t.title,
                        "description": t.description,
                        "priority": t.priority.name,
                        "confidence": t.confidence
                    }
                    for t in tasks
                ]
            }
        
        async def get_daily_suggestions(self, target_date: Optional[str] = None) -> dict:
            """Get daily suggestions."""
            date_obj = None
            if target_date:
                from datetime import datetime as dt
                date_obj = dt.fromisoformat(target_date).date()
            return await self.predictive.get_daily_suggestions(date_obj)
        
        async def record_response(self, task_title: str, accepted: bool) -> dict:
            """Record user response to suggestion."""
            await self.predictive.record_suggestion_response(task_title, accepted)
            return {"success": True, "recorded": True}
        
        async def get_effectiveness(self) -> dict:
            """Get suggestion effectiveness."""
            return await self.predictive.get_suggestion_effectiveness()
    
    return PredictiveTasksServer()
