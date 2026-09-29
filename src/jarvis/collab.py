"""
CollaborationAwareness Module: Real-time collaboration detection and sync.

Provides APIs for:
- Detecting active collaborators on shared documents
- Watching for changes from other users
- Syncing collaboration context
- Notifying about concurrent edits
"""

from dataclasses import dataclass, field
from typing import Optional, List, AsyncIterator
from datetime import datetime
from enum import Enum
import json
from pathlib import Path
import asyncio


class CollabEventType(Enum):
    """Types of collaboration events."""
    USER_JOINED = "user_joined"
    USER_LEFT = "user_left"
    DOCUMENT_CHANGED = "document_changed"
    COMMENT_ADDED = "comment_added"
    EDIT_CONFLICT = "edit_conflict"
    PERMISSION_CHANGED = "permission_changed"


@dataclass
class Collaborator:
    """Represents an active collaborator."""
    user_id: str
    name: str
    email: str
    last_active: str  # ISO timestamp
    current_selection: Optional[dict] = None  # Line/column being edited
    color: str = "#0066cc"  # For highlighting
    status: str = "active"  # active, idle, offline


@dataclass
class CollabEvent:
    """A collaboration event."""
    event_type: CollabEventType
    timestamp: str
    user: str
    document_path: str
    content: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class CollabContext:
    """Context for collaboration."""
    document_path: str
    collaborators: List[Collaborator] = field(default_factory=list)
    recent_changes: List[CollabEvent] = field(default_factory=list)
    last_synced: str = ""
    merge_strategy: str = "last_write_wins"  # or "ours", "theirs", "manual"


class CollaborationAwareness:
    """Real-time collaboration management."""
    
    def __init__(self):
        self.watched_documents: dict[str, CollabContext] = {}
        self.active_sessions: dict = {}
        self.event_listeners: dict[str, list] = {}
    
    async def detect_active_collaborators(self, doc_path: str) -> List[Collaborator]:
        """
        Detect who is actively working on a document.
        
        Args:
            doc_path: Path to the document
            
        Returns:
            List of active collaborators
        """
        # In production, this would query Google Drive, Microsoft 365, Notion, etc.
        # For now, return empty list or cached data
        
        context = self.watched_documents.get(doc_path)
        if context:
            return context.collaborators
        
        return []
    
    async def watch_collab_changes(
        self,
        doc_path: str
    ) -> AsyncIterator[CollabEvent]:
        """
        Watch for changes from collaborators on a document.
        
        Args:
            doc_path: Path to watch
            
        Yields:
            CollabEvent for each change detected
        """
        if doc_path not in self.watched_documents:
            self.watched_documents[doc_path] = CollabContext(document_path=doc_path)
        
        # Set up async event queue
        event_queue = asyncio.Queue()
        if doc_path not in self.event_listeners:
            self.event_listeners[doc_path] = []
        self.event_listeners[doc_path].append(event_queue)
        
        try:
            while True:
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=300)  # 5 min timeout
                    yield event
                except asyncio.TimeoutError:
                    # Yield keep-alive event
                    yield CollabEvent(
                        event_type=CollabEventType.USER_JOINED,
                        timestamp=datetime.now().isoformat(),
                        user="system",
                        document_path=doc_path,
                        metadata={"keep_alive": True}
                    )
        finally:
            self.event_listeners[doc_path].remove(event_queue)
    
    async def sync_collab_context(self, doc_path: Optional[str] = None) -> dict:
        """
        Sync collaboration context for one or all documents.
        
        Args:
            doc_path: Optional specific document, or None for all
            
        Returns:
            Dict of collaboration state
        """
        if doc_path:
            context = self.watched_documents.get(doc_path)
            if context:
                return {
                    "document": doc_path,
                    "collaborators": [
                        {
                            "name": c.name,
                            "email": c.email,
                            "status": c.status,
                            "last_active": c.last_active
                        }
                        for c in context.collaborators
                    ],
                    "recent_changes": len(context.recent_changes),
                    "last_synced": datetime.now().isoformat()
                }
        else:
            # Return all
            return {
                "documents": len(self.watched_documents),
                "total_collaborators": sum(
                    len(ctx.collaborators) for ctx in self.watched_documents.values()
                ),
                "last_synced": datetime.now().isoformat()
            }
        
        return {"status": "no_collaboration"}
    
    async def notify_change(self, event: CollabEvent) -> None:
        """
        Notify listeners about a change (internal use).
        
        Args:
            event: The collaboration event
        """
        if event.document_path in self.event_listeners:
            for queue in self.event_listeners[event.document_path]:
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    pass
    
    async def handle_edit_conflict(
        self,
        doc_path: str,
        our_content: str,
        their_content: str,
        our_edit: dict,
        their_edit: dict
    ) -> str:
        """
        Handle conflicting edits from multiple collaborators.
        
        Args:
            doc_path: Document path
            our_content: Our version
            their_content: Their version
            our_edit: Our edit details
            their_edit: Their edit details
            
        Returns:
            Resolved content
        """
        context = self.watched_documents.get(doc_path)
        if not context:
            return our_content
        
        strategy = context.merge_strategy
        
        if strategy == "ours":
            return our_content
        elif strategy == "theirs":
            return their_content
        elif strategy == "last_write_wins":
            # Check timestamps
            our_time = our_edit.get("timestamp", 0)
            their_time = their_edit.get("timestamp", 0)
            return their_content if their_time > our_time else our_content
        else:  # manual
            # Return conflict marker for manual resolution
            return f"""<<<<<<< OURS
{our_content}
=======
{their_content}
>>>>>>> THEIRS"""
    
    async def broadcast_presence(
        self,
        doc_path: str,
        user_id: str,
        user_name: str,
        status: str = "active"
    ) -> None:
        """
        Broadcast user presence to collaborators.
        
        Args:
            doc_path: Document being worked on
            user_id: User identifier
            user_name: User name
            status: User status (active, idle, offline)
        """
        if doc_path not in self.watched_documents:
            self.watched_documents[doc_path] = CollabContext(document_path=doc_path)
        
        context = self.watched_documents[doc_path]
        
        # Update or add collaborator
        for collab in context.collaborators:
            if collab.user_id == user_id:
                collab.status = status
                collab.last_active = datetime.now().isoformat()
                break
        else:
            context.collaborators.append(Collaborator(
                user_id=user_id,
                name=user_name,
                email="",
                last_active=datetime.now().isoformat(),
                status=status
            ))
        
        # Notify listeners
        event = CollabEvent(
            event_type=CollabEventType.USER_JOINED if status == "active" else CollabEventType.USER_LEFT,
            timestamp=datetime.now().isoformat(),
            user=user_name,
            document_path=doc_path,
            metadata={"user_id": user_id, "status": status}
        )
        await self.notify_change(event)
    
    async def get_document_insights(self, doc_path: str) -> dict:
        """
        Get insights about document collaboration.
        
        Args:
            doc_path: Document to analyze
            
        Returns:
            Dict with collaboration insights
        """
        context = self.watched_documents.get(doc_path)
        if not context:
            return {"status": "not_watched"}
        
        return {
            "document": doc_path,
            "collaborators_count": len(context.collaborators),
            "collaborators": [c.name for c in context.collaborators],
            "active_collaborators": len([c for c in context.collaborators if c.status == "active"]),
            "recent_changes_count": len(context.recent_changes),
            "last_change": context.recent_changes[-1].timestamp if context.recent_changes else None,
            "merge_conflicts": len([c for c in context.recent_changes if c.event_type == CollabEventType.EDIT_CONFLICT])
        }


# MCP Server builder
def build_server():
    """Build MCP server for CollaborationAwareness."""
    
    collab = CollaborationAwareness()
    
    class CollabServer:
        """MCP server for collaboration operations."""
        
        def __init__(self):
            self.collab = collab
        
        async def detect_collaborators(self, doc_path: str) -> dict:
            """Detect active collaborators."""
            collaborators = await self.collab.detect_active_collaborators(doc_path)
            return {
                "document": doc_path,
                "count": len(collaborators),
                "collaborators": [
                    {
                        "name": c.name,
                        "email": c.email,
                        "status": c.status,
                        "last_active": c.last_active
                    }
                    for c in collaborators
                ]
            }
        
        async def sync_context(self, doc_path: Optional[str] = None) -> dict:
            """Sync collaboration context."""
            return await self.collab.sync_collab_context(doc_path)
        
        async def broadcast_presence(
            self,
            doc_path: str,
            user_id: str,
            user_name: str,
            status: str = "active"
        ) -> dict:
            """Broadcast user presence."""
            await self.collab.broadcast_presence(doc_path, user_id, user_name, status)
            return {"success": True, "user": user_name, "document": doc_path}
        
        async def get_document_insights(self, doc_path: str) -> dict:
            """Get document collaboration insights."""
            return await self.collab.get_document_insights(doc_path)
    
    return CollabServer()
