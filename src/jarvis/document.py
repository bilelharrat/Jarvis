"""
DocumentHandler Module: Complex document reading, composition, and modification.

Provides APIs for:
- Reading documents with context preservation
- Composing structured documents from templates
- Modifying files with precision edits
- Voice-to-text handoff state management
"""

import json
import os
from dataclasses import dataclass, asdict, field
from typing import Optional, Any
from pathlib import Path
import asyncio
from datetime import datetime
import hashlib


@dataclass
class TextEdit:
    """A single text edit operation."""
    line: int
    column: int
    text: str
    old_text: Optional[str] = None


@dataclass
class DocumentContext:
    """Context preserved while reading a document."""
    path: str
    content: str
    file_type: str  # "markdown", "text", "pdf", "docx"
    encoding: str = "utf-8"
    line_count: int = 0
    word_count: int = 0
    last_modified: Optional[str] = None
    hash: str = ""
    metadata: dict = field(default_factory=dict)
    sections: list[dict] = field(default_factory=list)  # For multi-section docs
    
    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class HandoffState:
    """State for voice-to-text handoff continuity."""
    session_id: str
    audio_chunks: list[bytes] = field(default_factory=list)
    transcript_draft: str = ""
    context_snippet: str = ""
    timestamp: str = ""
    language: str = "en-US"
    document_target: Optional[str] = None  # Path to target document
    
    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "transcript_draft": self.transcript_draft,
            "context_snippet": self.context_snippet,
            "timestamp": self.timestamp,
            "language": self.language,
            "document_target": self.document_target,
            "audio_chunks_count": len(self.audio_chunks)
        }


class DocumentHandler:
    """Core document handling with context preservation."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.drafts_path = self.storage_path / ".jarvis" / "drafts.json"
        self.drafts_path.parent.mkdir(parents=True, exist_ok=True)
        self.handoff_states: dict[str, HandoffState] = {}
        self._load_drafts()
    
    def _load_drafts(self) -> None:
        """Load persisted drafts from disk."""
        if self.drafts_path.exists():
            try:
                with open(self.drafts_path) as f:
                    data = json.load(f)
                    # Reconstruct handoff states from persisted data
                    for session_id, state_data in data.items():
                        self.handoff_states[session_id] = HandoffState(**state_data)
            except (json.JSONDecodeError, TypeError):
                pass
    
    def _save_drafts(self) -> None:
        """Persist drafts to disk."""
        data = {sid: state.to_dict() for sid, state in self.handoff_states.items()}
        with open(self.drafts_path, 'w') as f:
            json.dump(data, f, indent=2)
    
    async def read_document(
        self, 
        path: str, 
        preserve_context: bool = True
    ) -> DocumentContext:
        """
        Read a document with context preservation.
        
        Args:
            path: File path to read
            preserve_context: Whether to extract sections and metadata
            
        Returns:
            DocumentContext with full document info
        """
        file_path = Path(path).expanduser()
        
        if not file_path.exists():
            raise FileNotFoundError(f"Document not found: {path}")
        
        # Read file content
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except UnicodeDecodeError:
            # Fallback for binary/other encodings
            with open(file_path, 'rb') as f:
                content = f.read().decode('utf-8', errors='replace')
        
        # Determine file type
        suffix = file_path.suffix.lower()
        file_type_map = {
            '.md': 'markdown',
            '.txt': 'text',
            '.pdf': 'pdf',
            '.docx': 'docx',
            '.py': 'code',
            '.ts': 'code',
            '.js': 'code',
        }
        file_type = file_type_map.get(suffix, 'text')
        
        # Calculate stats
        lines = content.split('\n')
        words = len(content.split())
        file_hash = hashlib.md5(content.encode()).hexdigest()
        
        # Extract sections if requested
        sections = []
        if preserve_context and file_type == 'markdown':
            sections = self._extract_sections(content)
        
        # Get file metadata
        stat = file_path.stat()
        last_modified = datetime.fromtimestamp(stat.st_mtime).isoformat()
        
        context = DocumentContext(
            path=str(file_path),
            content=content,
            file_type=file_type,
            line_count=len(lines),
            word_count=words,
            last_modified=last_modified,
            hash=file_hash,
            sections=sections
        )
        
        return context
    
    def _extract_sections(self, content: str) -> list[dict]:
        """Extract markdown sections for context preservation."""
        sections = []
        lines = content.split('\n')
        current_section = None
        
        for i, line in enumerate(lines):
            if line.startswith('# '):
                if current_section:
                    sections.append(current_section)
                current_section = {
                    'level': 1,
                    'title': line[2:].strip(),
                    'line_start': i,
                    'content': []
                }
            elif line.startswith('## '):
                if current_section:
                    sections.append(current_section)
                current_section = {
                    'level': 2,
                    'title': line[3:].strip(),
                    'line_start': i,
                    'content': []
                }
            elif current_section:
                current_section['content'].append(line)
        
        if current_section:
            sections.append(current_section)
        
        return sections
    
    async def compose_document(
        self,
        template: str,
        sections: dict[str, str],
        output_path: Optional[str] = None
    ) -> str:
        """
        Compose a structured document from template and sections.
        
        Args:
            template: Template string with {section_name} placeholders
            sections: Dictionary of section_name -> content
            output_path: Optional path to write composed document
            
        Returns:
            Composed document content
        """
        composed = template
        for name, content in sections.items():
            placeholder = "{" + name + "}"
            composed = composed.replace(placeholder, content)
        
        if output_path:
            output = Path(output_path).expanduser()
            output.parent.mkdir(parents=True, exist_ok=True)
            with open(output, 'w', encoding='utf-8') as f:
                f.write(composed)
        
        return composed
    
    async def modify_file(
        self,
        path: str,
        edits: list[TextEdit]
    ) -> bool:
        """
        Apply precise text edits to a file.
        
        Args:
            path: File path to modify
            edits: List of TextEdit operations
            
        Returns:
            True if successful
        """
        file_path = Path(path).expanduser()
        
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        
        # Read current content
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        # Sort edits by line (descending) to apply from end to start
        sorted_edits = sorted(edits, key=lambda e: (e.line, e.column), reverse=True)
        
        # Apply edits
        for edit in sorted_edits:
            if edit.line >= len(lines):
                continue
            
            line = lines[edit.line]
            # Replace text at column position
            if edit.old_text and edit.old_text in line:
                lines[edit.line] = line.replace(edit.old_text, edit.text, 1)
            else:
                # Insert at column
                lines[edit.line] = line[:edit.column] + edit.text + line[edit.column:]
        
        # Write back
        with open(file_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        
        return True
    
    async def create_handoff_state(
        self,
        context_snippet: str,
        document_target: Optional[str] = None,
        language: str = "en-US"
    ) -> HandoffState:
        """
        Create a new voice-to-text handoff session.
        
        Args:
            context_snippet: Context from the document being worked on
            document_target: Path to target document for insertion
            language: Language for transcription
            
        Returns:
            HandoffState ready for audio streaming
        """
        import uuid
        session_id = str(uuid.uuid4())
        
        state = HandoffState(
            session_id=session_id,
            context_snippet=context_snippet,
            document_target=document_target,
            language=language,
            timestamp=datetime.now().isoformat()
        )
        
        self.handoff_states[session_id] = state
        self._save_drafts()
        
        return state
    
    async def add_audio_chunk(
        self,
        session_id: str,
        audio_chunk: bytes
    ) -> None:
        """Add audio chunk to a handoff session."""
        if session_id not in self.handoff_states:
            raise ValueError(f"Handoff session not found: {session_id}")
        
        self.handoff_states[session_id].audio_chunks.append(audio_chunk)
    
    async def update_transcript_draft(
        self,
        session_id: str,
        transcript: str
    ) -> None:
        """Update the transcript draft for a session."""
        if session_id not in self.handoff_states:
            raise ValueError(f"Handoff session not found: {session_id}")
        
        self.handoff_states[session_id].transcript_draft = transcript
        self._save_drafts()
    
    async def finalize_handoff(
        self,
        session_id: str,
        final_transcript: str
    ) -> str:
        """
        Finalize a handoff session and optionally insert into target document.
        
        Returns:
            Final transcript
        """
        if session_id not in self.handoff_states:
            raise ValueError(f"Handoff session not found: {session_id}")
        
        state = self.handoff_states[session_id]
        state.transcript_draft = final_transcript
        
        # If target document specified, this can be inserted by caller
        self._save_drafts()
        
        return final_transcript
    
    async def get_handoff_state(self, session_id: str) -> Optional[HandoffState]:
        """Retrieve a handoff state by ID."""
        return self.handoff_states.get(session_id)
    
    async def cancel_handoff(self, session_id: str) -> None:
        """Cancel and clean up a handoff session."""
        if session_id in self.handoff_states:
            del self.handoff_states[session_id]
            self._save_drafts()


# MCP Server builder for integration with hub.py
def build_server():
    """Build MCP server for DocumentHandler."""
    
    handler = DocumentHandler()
    
    class DocumentServer:
        """MCP server exposing document operations."""
        
        def __init__(self):
            self.handler = handler
        
        async def read_document(self, path: str) -> dict:
            """Read and return document with context."""
            ctx = await self.handler.read_document(path)
            return ctx.to_dict()
        
        async def compose_document(self, template: str, sections: dict, output_path: Optional[str] = None) -> dict:
            """Compose document from template."""
            result = await self.handler.compose_document(template, sections, output_path)
            return {"composed": result, "written": output_path is not None, "path": output_path}
        
        async def modify_file(self, path: str, edits: list[dict]) -> dict:
            """Apply edits to file."""
            edit_objects = [TextEdit(**e) for e in edits]
            success = await self.handler.modify_file(path, edit_objects)
            return {"success": success, "path": path, "edits_applied": len(edit_objects)}
        
        async def create_handoff(self, context_snippet: str, document_target: Optional[str] = None, language: str = "en-US") -> dict:
            """Create handoff session."""
            state = await self.handler.create_handoff_state(context_snippet, document_target, language)
            return state.to_dict()
        
        async def update_handoff_transcript(self, session_id: str, transcript: str) -> dict:
            """Update handoff transcript."""
            await self.handler.update_transcript_draft(session_id, transcript)
            state = await self.handler.get_handoff_state(session_id)
            return {"success": True, "state": state.to_dict() if state else None}
        
        async def finalize_handoff(self, session_id: str, final_transcript: str) -> dict:
            """Finalize handoff."""
            result = await self.handler.finalize_handoff(session_id, final_transcript)
            return {"success": True, "final_transcript": result, "session_id": session_id}
    
    return DocumentServer()
