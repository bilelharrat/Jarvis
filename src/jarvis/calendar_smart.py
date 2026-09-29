"""
CalendarIntelligence Module: Smart calendar editing and multi-calendar scheduling.

Provides APIs for:
- Direct calendar event editing
- Multi-calendar conflict resolution
- Optimal time slot finding
- Calendar consolidation suggestions
"""

from dataclasses import dataclass, asdict, field
from typing import Optional, List
from datetime import datetime, timedelta
from enum import Enum
import json


class EventStatus(Enum):
    """Event status enumeration."""
    CONFIRMED = "confirmed"
    TENTATIVE = "tentative"
    CANCELLED = "cancelled"


@dataclass
class Timeslot:
    """Represents an available time slot."""
    start: str  # ISO format
    end: str
    duration_minutes: int
    conflicts: List[str] = field(default_factory=list)
    confidence: float = 1.0  # 0.0-1.0 availability confidence


@dataclass
class EventEdit:
    """Represents changes to a calendar event."""
    event_id: str
    calendar_id: str
    title: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    attendees: Optional[List[str]] = None
    status: Optional[EventStatus] = None


@dataclass
class CalendarConflict:
    """Represents a conflict between events."""
    event_id_1: str
    event_id_2: str
    calendar_1: str
    calendar_2: str
    overlap_minutes: int
    severity: str  # "low", "medium", "high"


class CalendarIntelligence:
    """Smart calendar operations."""
    
    def __init__(self):
        self.conflicts_cache: dict = {}
        self.optimization_preferences: dict = {}
    
    async def edit_event(
        self,
        edit: EventEdit
    ) -> dict:
        """
        Edit a calendar event with conflict detection.
        
        Args:
            edit: EventEdit describing changes
            
        Returns:
            Success dict with updated event info
        """
        # Validate the edit
        if not edit.event_id or not edit.calendar_id:
            return {"success": False, "error": "Missing event_id or calendar_id"}
        
        # Check for conflicts if time is being changed
        conflicts = []
        if edit.start_time or edit.end_time:
            conflicts = await self.check_conflicts(
                edit.calendar_id,
                edit.start_time,
                edit.end_time,
                exclude_event_id=edit.event_id
            )
        
        if conflicts:
            # Return conflicts for user resolution
            return {
                "success": False,
                "requires_review": True,
                "event_id": edit.event_id,
                "conflicts": [asdict(c) for c in conflicts],
                "message": f"Found {len(conflicts)} scheduling conflict(s)"
            }
        
        # Apply the edit (would call actual calendar API in production)
        return {
            "success": True,
            "event_id": edit.event_id,
            "changes_applied": {
                "title": edit.title,
                "start_time": edit.start_time,
                "end_time": edit.end_time,
                "location": edit.location,
                "attendees": edit.attendees
            }
        }
    
    async def check_conflicts(
        self,
        calendar_id: str,
        start_time: Optional[str],
        end_time: Optional[str],
        exclude_event_id: Optional[str] = None
    ) -> List[CalendarConflict]:
        """
        Check for conflicts in a specific time range.
        
        Args:
            calendar_id: Calendar to check
            start_time: ISO format start time
            end_time: ISO format end time
            exclude_event_id: Event ID to skip (for edits)
            
        Returns:
            List of conflicts found
        """
        # In production, this would query the calendar API
        # For now, return empty list
        return []
    
    async def find_optimal_slot(
        self,
        attendees: List[str],
        duration_minutes: int,
        constraints: Optional[dict] = None
    ) -> List[Timeslot]:
        """
        Find optimal meeting time slots across multiple calendars.
        
        Args:
            attendees: List of attendee emails
            duration_minutes: Meeting duration
            constraints: Optional constraints like:
                - earliest_time: "09:00"
                - latest_time: "17:00"
                - exclude_weekends: bool
                - next_n_days: int
                - preferred_times: ["09:00-11:00", "14:00-16:00"]
            
        Returns:
            List of Timeslot objects ranked by availability
        """
        constraints = constraints or {}
        next_n_days = constraints.get("next_n_days", 7)
        exclude_weekends = constraints.get("exclude_weekends", True)
        earliest = constraints.get("earliest_time", "08:00")
        latest = constraints.get("latest_time", "18:00")
        
        slots = []
        now = datetime.now()
        
        # Generate candidate slots
        for day_offset in range(next_n_days):
            check_date = now + timedelta(days=day_offset)
            
            # Skip weekends if requested
            if exclude_weekends and check_date.weekday() >= 5:
                continue
            
            # Check 30-minute increments
            hour = int(earliest.split(':')[0])
            minute = 0
            
            while True:
                slot_time = check_date.replace(hour=hour, minute=minute)
                slot_end = slot_time + timedelta(minutes=duration_minutes)
                
                slot_end_hour = int(latest.split(':')[0])
                if slot_end.hour > slot_end_hour:
                    break
                
                slot = Timeslot(
                    start=slot_time.isoformat(),
                    end=slot_end.isoformat(),
                    duration_minutes=duration_minutes,
                    confidence=0.95  # Default high confidence
                )
                slots.append(slot)
                
                minute += 30
                if minute >= 60:
                    minute = 0
                    hour += 1
        
        # In production, filter by actual calendar availability
        # and rank by preference
        return slots[:10]  # Return top 10 slots
    
    async def suggest_calendar_consolidation(self) -> dict:
        """
        Suggest consolidation of multiple calendars.
        
        Returns:
            Consolidation plan with recommendations
        """
        return {
            "calendars": [],
            "suggestions": [],
            "estimated_time_savings_hours": 0,
            "recommended_order": []
        }
    
    async def resolve_multi_calendar_event(
        self,
        event_data: dict,
        calendar_preference: Optional[str] = None
    ) -> dict:
        """
        Intelligently place event across multiple calendars.
        
        Args:
            event_data: Event details
            calendar_preference: Preferred calendar ID
            
        Returns:
            Placement recommendation and booking result
        """
        return {
            "success": True,
            "event_id": event_data.get("id"),
            "placed_in_calendar": calendar_preference,
            "recommendation": "Primary calendar recommended"
        }
    
    async def get_calendar_availability_summary(self) -> dict:
        """
        Get summary of availability across all calendars for the week.
        
        Returns:
            Summary with available hours, busy times, etc.
        """
        return {
            "total_busy_hours": 0,
            "total_free_hours": 0,
            "busiest_day": None,
            "least_busy_day": None,
            "recommendation": "Schedule important meetings early in the week"
        }


# MCP Server builder
def build_server():
    """Build MCP server for CalendarIntelligence."""
    
    calendar_intel = CalendarIntelligence()
    
    class CalendarSmartServer:
        """MCP server for smart calendar operations."""
        
        def __init__(self):
            self.calendar = calendar_intel
        
        async def edit_event(self, event_id: str, calendar_id: str, changes: dict) -> dict:
            """Edit calendar event."""
            edit = EventEdit(
                event_id=event_id,
                calendar_id=calendar_id,
                **changes
            )
            return await self.calendar.edit_event(edit)
        
        async def find_optimal_slot(self, attendees: list, duration_minutes: int, constraints: Optional[dict] = None) -> dict:
            """Find optimal meeting time."""
            slots = await self.calendar.find_optimal_slot(attendees, duration_minutes, constraints)
            return {
                "success": True,
                "slots": [asdict(s) for s in slots],
                "count": len(slots)
            }
        
        async def suggest_consolidation(self) -> dict:
            """Get calendar consolidation suggestions."""
            return await self.calendar.suggest_calendar_consolidation()
        
        async def get_availability_summary(self) -> dict:
            """Get weekly availability summary."""
            return await self.calendar.get_calendar_availability_summary()
    
    return CalendarSmartServer()
