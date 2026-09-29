"""
DecisionLearning Module: Learn from user decisions and predict future choices.

Provides APIs for:
- Recording decisions and their context
- Analyzing decision patterns
- Predicting likely choices in similar situations
"""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime
from pathlib import Path
import json
import hashlib


@dataclass
class DecisionContext:
    """Context around a decision."""
    domain: str  # e.g., "scheduling", "spending", "communication"
    options: List[str]  # Available choices
    constraints: dict = field(default_factory=dict)
    time: str = ""
    location: Optional[str] = None
    participants: List[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


@dataclass
class Decision:
    """A recorded decision."""
    decision_id: str
    context: DecisionContext
    chosen_option: str
    outcome: Optional[str] = None
    confidence: float = 0.5  # 0.0-1.0 in the decision
    timestamp: str = ""
    explanation: Optional[str] = None


@dataclass
class DecisionPattern:
    """Learned pattern in decision-making."""
    domain: str
    pattern_id: str
    description: str
    trigger_conditions: dict
    predicted_choice: str
    confidence: float  # How often this pattern holds true
    frequency: int  # How many times observed
    examples: List[str] = field(default_factory=list)


@dataclass
class PredictedChoice:
    """Prediction for a choice in a given context."""
    option: str
    probability: float  # 0.0-1.0
    reasoning: str
    pattern_match_id: Optional[str] = None


class DecisionLearning:
    """Learn and predict from user decisions."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/.jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.decisions_file = self.storage_path / "decisions.json"
        self.patterns_file = self.storage_path / "decision_patterns.json"
        
        self.decisions: List[Decision] = []
        self.patterns: List[DecisionPattern] = []
        self._load_decisions()
    
    def _load_decisions(self) -> None:
        """Load decisions from disk."""
        if self.decisions_file.exists():
            try:
                with open(self.decisions_file) as f:
                    data = json.load(f)
                    # Reconstruct decisions (simplified for now)
                    self.decisions = data.get("decisions", [])
            except (json.JSONDecodeError, TypeError):
                pass
        
        if self.patterns_file.exists():
            try:
                with open(self.patterns_file) as f:
                    data = json.load(f)
                    self.patterns = data.get("patterns", [])
            except (json.JSONDecodeError, TypeError):
                pass
    
    def _save_decisions(self) -> None:
        """Persist decisions to disk."""
        data = {"decisions": self.decisions}
        with open(self.decisions_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        patterns_data = {"patterns": self.patterns}
        with open(self.patterns_file, 'w') as f:
            json.dump(patterns_data, f, indent=2)
    
    async def record_decision(
        self,
        context: DecisionContext,
        chosen_option: str,
        explanation: Optional[str] = None
    ) -> str:
        """
        Record a user decision for learning.
        
        Args:
            context: The decision context
            chosen_option: What was chosen
            explanation: Optional explanation from user
            
        Returns:
            Decision ID
        """
        import uuid
        decision_id = str(uuid.uuid4())
        
        decision = Decision(
            decision_id=decision_id,
            context=context,
            chosen_option=chosen_option,
            timestamp=datetime.now().isoformat(),
            explanation=explanation,
            confidence=0.7
        )
        
        self.decisions.append(decision)
        
        # Try to extract or update patterns
        await self._update_patterns()
        
        # Periodically save
        if len(self.decisions) % 5 == 0:
            self._save_decisions()
        
        return decision_id
    
    async def _update_patterns(self) -> None:
        """Analyze decisions to find patterns."""
        if len(self.decisions) < 3:
            return  # Need minimum data
        
        # Group by domain
        by_domain = {}
        for decision in self.decisions:
            domain = decision.context.domain
            if domain not in by_domain:
                by_domain[domain] = []
            by_domain[domain].append(decision)
        
        # Find patterns
        for domain, domain_decisions in by_domain.items():
            # Look for frequently chosen options
            choice_counts = {}
            for decision in domain_decisions:
                choice = decision.chosen_option
                choice_counts[choice] = choice_counts.get(choice, 0) + 1
            
            # Create pattern for most common choice
            if choice_counts:
                most_common = max(choice_counts, key=choice_counts.get)
                frequency = choice_counts[most_common]
                confidence = frequency / len(domain_decisions)
                
                if confidence >= 0.6:  # Only store confident patterns
                    pattern_id = hashlib.md5(f"{domain}_{most_common}".encode()).hexdigest()[:8]
                    
                    # Check if pattern already exists
                    existing = next((p for p in self.patterns if p.pattern_id == pattern_id), None)
                    if not existing:
                        pattern = DecisionPattern(
                            domain=domain,
                            pattern_id=pattern_id,
                            description=f"In {domain} contexts, usually choose '{most_common}'",
                            trigger_conditions={},
                            predicted_choice=most_common,
                            confidence=confidence,
                            frequency=frequency
                        )
                        self.patterns.append(pattern)
                    else:
                        existing.confidence = confidence
                        existing.frequency = frequency
    
    async def analyze_patterns(self) -> dict:
        """
        Analyze learned decision patterns.
        
        Returns:
            Dict with pattern analysis
        """
        if not self.patterns:
            return {"patterns_count": 0, "status": "insufficient_data"}
        
        return {
            "total_patterns": len(self.patterns),
            "patterns": [
                {
                    "domain": p.domain,
                    "predicted_choice": p.predicted_choice,
                    "confidence": p.confidence,
                    "frequency": p.frequency,
                    "description": p.description
                }
                for p in self.patterns
            ],
            "total_decisions_recorded": len(self.decisions),
            "domains_tracked": len(set(d.context.domain for d in self.decisions))
        }
    
    async def predict_choice(
        self,
        similar_context: DecisionContext
    ) -> List[PredictedChoice]:
        """
        Predict likely choice in a similar context.
        
        Args:
            similar_context: Context to predict for
            
        Returns:
            List of PredictedChoice ranked by probability
        """
        predictions = []
        
        # Find relevant patterns for this domain
        domain_patterns = [p for p in self.patterns if p.domain == similar_context.domain]
        
        for pattern in domain_patterns:
            prediction = PredictedChoice(
                option=pattern.predicted_choice,
                probability=pattern.confidence,
                reasoning=pattern.description,
                pattern_match_id=pattern.pattern_id
            )
            predictions.append(prediction)
        
        # If no patterns, use frequency analysis on raw decisions
        if not predictions:
            domain_decisions = [d for d in self.decisions if d.context.domain == similar_context.domain]
            if domain_decisions:
                choice_counts = {}
                for decision in domain_decisions:
                    choice = decision.chosen_option
                    choice_counts[choice] = choice_counts.get(choice, 0) + 1
                
                for choice, count in sorted(choice_counts.items(), key=lambda x: x[1], reverse=True):
                    prob = count / len(domain_decisions)
                    predictions.append(PredictedChoice(
                        option=choice,
                        probability=prob,
                        reasoning=f"Based on {count}/{len(domain_decisions)} similar decisions"
                    ))
        
        return sorted(predictions, key=lambda p: p.probability, reverse=True)
    
    async def get_decision_summary(self, domain: Optional[str] = None) -> dict:
        """
        Get summary of decisions by domain.
        
        Args:
            domain: Optional specific domain
            
        Returns:
            Summary dict
        """
        if domain:
            decisions = [d for d in self.decisions if d.context.domain == domain]
        else:
            decisions = self.decisions
        
        if not decisions:
            return {"status": "no_decisions"}
        
        return {
            "total_decisions": len(decisions),
            "domain": domain,
            "unique_choices": len(set(d.chosen_option for d in decisions)),
            "most_common": max(
                set(d.chosen_option for d in decisions),
                key=lambda c: sum(1 for d in decisions if d.chosen_option == c),
                default=None
            ),
            "date_range": {
                "earliest": min(d.timestamp for d in decisions),
                "latest": max(d.timestamp for d in decisions)
            }
        }


# MCP Server builder
def build_server():
    """Build MCP server for DecisionLearning."""
    
    learning = DecisionLearning()
    
    class DecisionLearningServer:
        """MCP server for decision tracking."""
        
        def __init__(self):
            self.learning = learning
        
        async def record_decision(self, domain: str, options: list, chosen: str, explanation: Optional[str] = None) -> dict:
            """Record a decision."""
            context = DecisionContext(domain=domain, options=options)
            decision_id = await self.learning.record_decision(context, chosen, explanation)
            return {"success": True, "decision_id": decision_id}
        
        async def analyze_patterns(self) -> dict:
            """Analyze learned patterns."""
            return await self.learning.analyze_patterns()
        
        async def predict_choice(self, domain: str, options: list) -> dict:
            """Predict choice in a domain."""
            context = DecisionContext(domain=domain, options=options)
            predictions = await self.learning.predict_choice(context)
            return {
                "domain": domain,
                "predictions": [
                    {"option": p.option, "probability": p.probability, "reasoning": p.reasoning}
                    for p in predictions
                ]
            }
        
        async def get_summary(self, domain: Optional[str] = None) -> dict:
            """Get decision summary."""
            return await self.learning.get_decision_summary(domain)
    
    return DecisionLearningServer()
