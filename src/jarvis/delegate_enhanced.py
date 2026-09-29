"""
EnhancedDelegation Module: Autonomous task delegation with optional checkpoints.

Provides APIs for:
- Creating delegations with checkpoint rules
- Managing checkpoint approvals
- Autonomous execution with user-defined thresholds
- Delegation tracking and reporting
"""

from dataclasses import dataclass, field
from typing import Optional, List, Callable
from datetime import datetime
from enum import Enum
import json
from pathlib import Path
import uuid


class DelegationStatus(Enum):
    """Status of a delegation."""
    CREATED = "created"
    EXECUTING = "executing"
    AWAITING_CHECKPOINT = "awaiting_checkpoint"
    APPROVED = "approved"
    REJECTED = "rejected"
    COMPLETED = "completed"
    FAILED = "failed"


class CheckpointType(Enum):
    """Types of checkpoints."""
    APPROVAL_REQUIRED = "approval_required"
    CONFIRMATION = "confirmation"
    COST_THRESHOLD = "cost_threshold"
    SCOPE_CHANGE = "scope_change"
    ESCALATION = "escalation"


@dataclass
class CheckpointRule:
    """Rule for when to checkpoint during delegation."""
    checkpoint_type: CheckpointType
    condition: str  # e.g., "cost > $100", "scope changes"
    require_approval: bool = True
    auto_escalate: bool = False
    escalate_to: Optional[str] = None  # Contact/person to escalate to


@dataclass
class Checkpoint:
    """A checkpoint in a delegation."""
    checkpoint_id: str
    delegation_id: str
    checkpoint_type: CheckpointType
    message: str
    triggered_at: str
    requires_approval: bool
    approved: bool = False
    approval_at: Optional[str] = None
    approved_by: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class Delegation:
    """A delegated task/mandate."""
    delegation_id: str
    title: str
    description: str
    mandate: str  # What to do
    status: DelegationStatus = DelegationStatus.CREATED
    checkpoint_rules: List[CheckpointRule] = field(default_factory=list)
    auto_approve_threshold: float = 0.8  # Confidence threshold for auto-approval (0.0-1.0)
    created_at: str = ""
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    checkpoints: List[Checkpoint] = field(default_factory=list)
    execution_notes: List[str] = field(default_factory=list)
    result: Optional[str] = None
    metadata: dict = field(default_factory=dict)


class EnhancedDelegation:
    """Enhanced autonomous delegation with checkpoints."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/.jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.delegations_file = self.storage_path / "delegations.json"
        
        self.delegations: dict[str, Delegation] = {}
        self.pending_checkpoints: List[Checkpoint] = []
        self._load_delegations()
    
    def _load_delegations(self) -> None:
        """Load delegations from disk."""
        if self.delegations_file.exists():
            try:
                with open(self.delegations_file) as f:
                    data = json.load(f)
                    # Reconstruct delegations (simplified)
                    delegations_list = data.get("delegations", []) if isinstance(data, dict) else []
                    for del_data in delegations_list:
                        if isinstance(del_data, dict):
                            delegation_id = del_data.get("delegation_id")
                            if delegation_id:
                                self.delegations[delegation_id] = del_data
            except (json.JSONDecodeError, TypeError, AttributeError):
                pass
    
    def _save_delegations(self) -> None:
        """Persist delegations to disk."""
        data = {
            "delegations": list(self.delegations.values()),
            "timestamp": datetime.now().isoformat()
        }
        with open(self.delegations_file, 'w') as f:
            json.dump(data, f, indent=2, default=str)
    
    async def create_delegation_with_checkpoints(
        self,
        title: str,
        mandate: str,
        checkpoint_rules: Optional[List[CheckpointRule]] = None,
        auto_approve_threshold: float = 0.8,
        metadata: Optional[dict] = None
    ) -> Delegation:
        """
        Create a delegation with optional checkpoint rules.
        
        Args:
            title: Delegation title
            mandate: What to do
            checkpoint_rules: Optional list of checkpoint rules
            auto_approve_threshold: Confidence threshold for auto-approval
            metadata: Optional metadata
            
        Returns:
            Created Delegation
        """
        delegation_id = str(uuid.uuid4())
        
        delegation = Delegation(
            delegation_id=delegation_id,
            title=title,
            description=f"Delegation: {mandate[:100]}",
            mandate=mandate,
            checkpoint_rules=checkpoint_rules or [],
            auto_approve_threshold=auto_approve_threshold,
            created_at=datetime.now().isoformat(),
            metadata=metadata or {}
        )
        
        self.delegations[delegation_id] = delegation
        self._save_delegations()
        
        return delegation
    
    async def start_delegation_execution(
        self,
        delegation_id: str
    ) -> dict:
        """
        Start executing a delegation.
        
        Args:
            delegation_id: Delegation ID
            
        Returns:
            Execution status
        """
        if delegation_id not in self.delegations:
            return {"success": False, "error": "Delegation not found"}
        
        delegation = self.delegations[delegation_id]
        if isinstance(delegation, dict):
            delegation["status"] = DelegationStatus.EXECUTING.value
            delegation["started_at"] = datetime.now().isoformat()
        else:
            delegation.status = DelegationStatus.EXECUTING
            delegation.started_at = datetime.now().isoformat()
        
        self._save_delegations()
        
        return {
            "success": True,
            "delegation_id": delegation_id,
            "status": "executing"
        }
    
    async def trigger_checkpoint(
        self,
        delegation_id: str,
        checkpoint_type: CheckpointType,
        message: str,
        metadata: Optional[dict] = None
    ) -> Checkpoint:
        """
        Trigger a checkpoint during delegation execution.
        
        Args:
            delegation_id: Delegation ID
            checkpoint_type: Type of checkpoint
            message: Checkpoint message
            metadata: Optional metadata
            
        Returns:
            Created Checkpoint
        """
        if delegation_id not in self.delegations:
            raise ValueError(f"Delegation not found: {delegation_id}")
        
        checkpoint_id = str(uuid.uuid4())
        checkpoint = Checkpoint(
            checkpoint_id=checkpoint_id,
            delegation_id=delegation_id,
            checkpoint_type=checkpoint_type,
            message=message,
            triggered_at=datetime.now().isoformat(),
            requires_approval=True,
            metadata=metadata or {}
        )
        
        delegation = self.delegations[delegation_id]
        if isinstance(delegation, dict):
            if "checkpoints" not in delegation:
                delegation["checkpoints"] = []
            delegation["checkpoints"].append(checkpoint.__dict__)
            delegation["status"] = DelegationStatus.AWAITING_CHECKPOINT.value
        else:
            delegation.checkpoints.append(checkpoint)
            delegation.status = DelegationStatus.AWAITING_CHECKPOINT
        
        self.pending_checkpoints.append(checkpoint)
        self._save_delegations()
        
        return checkpoint
    
    async def approve_checkpoint(
        self,
        checkpoint_id: str,
        approved_by: str = "user"
    ) -> dict:
        """
        Approve a pending checkpoint.
        
        Args:
            checkpoint_id: Checkpoint ID
            approved_by: Who approved (e.g., "user", "admin")
            
        Returns:
            Approval result
        """
        checkpoint = next((c for c in self.pending_checkpoints if c.checkpoint_id == checkpoint_id), None)
        
        if not checkpoint:
            return {"success": False, "error": "Checkpoint not found"}
        
        checkpoint.approved = True
        checkpoint.approval_at = datetime.now().isoformat()
        checkpoint.approved_by = approved_by
        
        # Update delegation status
        delegation_id = checkpoint.delegation_id
        if delegation_id in self.delegations:
            delegation = self.delegations[delegation_id]
            if isinstance(delegation, dict):
                delegation["status"] = DelegationStatus.APPROVED.value
            else:
                delegation.status = DelegationStatus.APPROVED
        
        self.pending_checkpoints.remove(checkpoint)
        self._save_delegations()
        
        return {
            "success": True,
            "checkpoint_id": checkpoint_id,
            "approved": True,
            "approved_by": approved_by
        }
    
    async def reject_checkpoint(
        self,
        checkpoint_id: str,
        reason: str
    ) -> dict:
        """
        Reject a pending checkpoint.
        
        Args:
            checkpoint_id: Checkpoint ID
            reason: Rejection reason
            
        Returns:
            Rejection result
        """
        checkpoint = next((c for c in self.pending_checkpoints if c.checkpoint_id == checkpoint_id), None)
        
        if not checkpoint:
            return {"success": False, "error": "Checkpoint not found"}
        
        # Update delegation
        delegation_id = checkpoint.delegation_id
        if delegation_id in self.delegations:
            delegation = self.delegations[delegation_id]
            if isinstance(delegation, dict):
                delegation["status"] = DelegationStatus.REJECTED.value
                delegation["execution_notes"].append(f"Rejected at checkpoint: {reason}")
            else:
                delegation.status = DelegationStatus.REJECTED
                delegation.execution_notes.append(f"Rejected at checkpoint: {reason}")
        
        self.pending_checkpoints.remove(checkpoint)
        self._save_delegations()
        
        return {
            "success": True,
            "checkpoint_id": checkpoint_id,
            "rejected": True,
            "reason": reason
        }
    
    async def complete_delegation(
        self,
        delegation_id: str,
        result: str
    ) -> dict:
        """
        Mark a delegation as complete.
        
        Args:
            delegation_id: Delegation ID
            result: Result/outcome of delegation
            
        Returns:
            Completion status
        """
        if delegation_id not in self.delegations:
            return {"success": False, "error": "Delegation not found"}
        
        delegation = self.delegations[delegation_id]
        if isinstance(delegation, dict):
            delegation["status"] = DelegationStatus.COMPLETED.value
            delegation["completed_at"] = datetime.now().isoformat()
            delegation["result"] = result
        else:
            delegation.status = DelegationStatus.COMPLETED
            delegation.completed_at = datetime.now().isoformat()
            delegation.result = result
        
        self._save_delegations()
        
        return {
            "success": True,
            "delegation_id": delegation_id,
            "status": "completed",
            "result": result
        }
    
    async def get_pending_checkpoints(self) -> List[dict]:
        """
        Get all pending checkpoints requiring approval.
        
        Returns:
            List of pending checkpoint dicts
        """
        return [
            {
                "checkpoint_id": c.checkpoint_id,
                "delegation_id": c.delegation_id,
                "type": c.checkpoint_type.value,
                "message": c.message,
                "triggered_at": c.triggered_at
            }
            for c in self.pending_checkpoints
        ]
    
    async def get_delegation_status(self, delegation_id: str) -> dict:
        """
        Get status of a delegation.
        
        Args:
            delegation_id: Delegation ID
            
        Returns:
            Delegation status dict
        """
        if delegation_id not in self.delegations:
            return {"error": "Delegation not found"}
        
        delegation = self.delegations[delegation_id]
        
        if isinstance(delegation, dict):
            return {
                "delegation_id": delegation_id,
                "title": delegation.get("title"),
                "status": delegation.get("status"),
                "started_at": delegation.get("started_at"),
                "completed_at": delegation.get("completed_at"),
                "checkpoints_count": len(delegation.get("checkpoints", [])),
                "result": delegation.get("result")
            }
        else:
            return {
                "delegation_id": delegation_id,
                "title": delegation.title,
                "status": delegation.status.value if delegation.status else None,
                "started_at": delegation.started_at,
                "completed_at": delegation.completed_at,
                "checkpoints_count": len(delegation.checkpoints),
                "result": delegation.result
            }


# MCP Server builder
def build_server():
    """Build MCP server for EnhancedDelegation."""
    
    delegation = EnhancedDelegation()
    
    class DelegationServer:
        """MCP server for delegation operations."""
        
        def __init__(self):
            self.delegation = delegation
        
        async def create_delegation(
            self,
            title: str,
            mandate: str,
            checkpoint_rules: Optional[list] = None,
            auto_approve_threshold: float = 0.8
        ) -> dict:
            """Create a delegation."""
            # Convert checkpoint rules dicts to objects
            rules = []
            if checkpoint_rules:
                for rule in checkpoint_rules:
                    rules.append(CheckpointRule(**rule))
            
            delegation_obj = await self.delegation.create_delegation_with_checkpoints(
                title, mandate, rules, auto_approve_threshold
            )
            
            return {
                "success": True,
                "delegation_id": delegation_obj.delegation_id,
                "title": delegation_obj.title,
                "status": delegation_obj.status.value
            }
        
        async def start_execution(self, delegation_id: str) -> dict:
            """Start delegation execution."""
            return await self.delegation.start_delegation_execution(delegation_id)
        
        async def trigger_checkpoint(
            self,
            delegation_id: str,
            checkpoint_type: str,
            message: str
        ) -> dict:
            """Trigger a checkpoint."""
            checkpoint_obj = await self.delegation.trigger_checkpoint(
                delegation_id,
                CheckpointType[checkpoint_type.upper()],
                message
            )
            return {
                "success": True,
                "checkpoint_id": checkpoint_obj.checkpoint_id,
                "requires_approval": checkpoint_obj.requires_approval
            }
        
        async def approve_checkpoint(self, checkpoint_id: str) -> dict:
            """Approve a checkpoint."""
            return await self.delegation.approve_checkpoint(checkpoint_id)
        
        async def reject_checkpoint(self, checkpoint_id: str, reason: str) -> dict:
            """Reject a checkpoint."""
            return await self.delegation.reject_checkpoint(checkpoint_id, reason)
        
        async def complete_delegation(self, delegation_id: str, result: str) -> dict:
            """Complete a delegation."""
            return await self.delegation.complete_delegation(delegation_id, result)
        
        async def get_pending_checkpoints(self) -> dict:
            """Get pending checkpoints."""
            checkpoints = await self.delegation.get_pending_checkpoints()
            return {
                "count": len(checkpoints),
                "checkpoints": checkpoints
            }
        
        async def get_status(self, delegation_id: str) -> dict:
            """Get delegation status."""
            return await self.delegation.get_delegation_status(delegation_id)
    
    return DelegationServer()
