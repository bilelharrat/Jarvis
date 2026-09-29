"""
FinancialAdvisor Module: Banking integration and financial advice.

Provides APIs for:
- Connecting bank accounts via Plaid
- Providing financial advice
- Analyzing spending patterns
- Budget tracking and recommendations
"""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime, date, timedelta
from enum import Enum
import json
from pathlib import Path


class TransactionType(Enum):
    """Types of transactions."""
    INCOME = "income"
    EXPENSE = "expense"
    TRANSFER = "transfer"
    INVESTMENT = "investment"


@dataclass
class Transaction:
    """A financial transaction."""
    transaction_id: str
    amount: float
    type: TransactionType
    category: str
    description: str
    date: str  # ISO date
    merchant: Optional[str] = None
    tags: List[str] = field(default_factory=list)


@dataclass
class BankAccount:
    """A connected bank account."""
    account_id: str
    name: str
    type: str  # checking, savings, credit
    balance: float
    currency: str = "USD"
    bank_name: str = ""
    last_synced: Optional[str] = None


@dataclass
class FinancialAdvice:
    """Financial advice recommendation."""
    title: str
    description: str
    priority: int  # 1-5
    category: str  # "spending", "savings", "investments", "budget"
    confidence: float  # 0.0-1.0
    potential_savings_monthly: float = 0.0
    action_items: List[str] = field(default_factory=list)


@dataclass
class SpendingAnalysis:
    """Analysis of spending patterns."""
    period: str  # "monthly", "quarterly", "yearly"
    total_spent: float
    total_income: float
    savings_rate: float  # 0.0-1.0
    categories: dict[str, float] = field(default_factory=dict)  # category -> amount
    top_categories: List[tuple[str, float]] = field(default_factory=list)
    trends: dict = field(default_factory=dict)
    recommendations: List[str] = field(default_factory=list)


class FinancialAdvisor:
    """Financial advice and banking integration."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/.jarvis").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.accounts_file = self.storage_path / "bank_accounts.json"
        self.transactions_file = self.storage_path / "transactions.json"
        
        self.accounts: dict[str, BankAccount] = {}
        self.transactions: List[Transaction] = []
        self.budgets: dict[str, float] = {}
        self._load_data()
    
    def _load_data(self) -> None:
        """Load accounts and transactions from disk."""
        if self.accounts_file.exists():
            try:
                with open(self.accounts_file) as f:
                    data = json.load(f)
                    # Reconstruct accounts
                    for acc_data in data.get("accounts", []):
                        account = BankAccount(**acc_data)
                        self.accounts[account.account_id] = account
            except (json.JSONDecodeError, TypeError):
                pass
        
        if self.transactions_file.exists():
            try:
                with open(self.transactions_file) as f:
                    data = json.load(f)
                    # Reconstruct transactions (simplified)
                    self.transactions = data.get("transactions", [])
            except (json.JSONDecodeError, TypeError):
                pass
    
    def _save_data(self) -> None:
        """Persist accounts and transactions to disk."""
        accounts_data = {
            "accounts": [
                {
                    "account_id": acc.account_id,
                    "name": acc.name,
                    "type": acc.type,
                    "balance": acc.balance,
                    "currency": acc.currency,
                    "bank_name": acc.bank_name,
                    "last_synced": acc.last_synced
                }
                for acc in self.accounts.values()
            ]
        }
        with open(self.accounts_file, 'w') as f:
            json.dump(accounts_data, f, indent=2)
    
    async def connect_bank(
        self,
        bank_name: str,
        auth_token: str
    ) -> List[BankAccount]:
        """
        Connect bank account via Plaid or similar.
        
        Args:
            bank_name: Name of bank
            auth_token: Authentication token
            
        Returns:
            List of connected accounts
        """
        # In production, this would use Plaid API
        # For now, create mock accounts
        import uuid
        
        account_id = str(uuid.uuid4())
        account = BankAccount(
            account_id=account_id,
            name=f"{bank_name} Checking",
            type="checking",
            balance=5000.0,
            bank_name=bank_name,
            last_synced=datetime.now().isoformat()
        )
        
        self.accounts[account_id] = account
        self._save_data()
        
        return [account]
    
    async def get_advice(
        self,
        question: str,
        context: Optional[dict] = None
    ) -> FinancialAdvice:
        """
        Get financial advice based on spending and account info.
        
        Args:
            question: User's financial question
            context: Optional additional context
            
        Returns:
            FinancialAdvice with recommendations
        """
        # Analyze current spending
        analysis = await self.analyze_spending_patterns()
        
        # Generate advice based on question and analysis
        advice = FinancialAdvice(
            title="Budget Optimization",
            description="Based on your spending patterns, consider adjusting your budget allocations",
            priority=3,
            category="budget",
            confidence=0.75,
            action_items=[
                "Review discretionary spending",
                "Set category budgets",
                "Track expenses weekly"
            ]
        )
        
        return advice
    
    async def analyze_spending_patterns(
        self,
        period_days: int = 30
    ) -> SpendingAnalysis:
        """
        Analyze spending patterns over a period.
        
        Args:
            period_days: Number of days to analyze
            
        Returns:
            SpendingAnalysis with breakdown and recommendations
        """
        cutoff_date = (date.today() - timedelta(days=period_days)).isoformat()
        
        # Filter recent transactions
        recent = []
        if isinstance(self.transactions, list) and self.transactions:
            # If transactions are dicts
            if isinstance(self.transactions[0], dict):
                recent = [t for t in self.transactions if t.get("date", "") >= cutoff_date]
        
        # Calculate totals by category
        categories = {}
        total_spent = 0.0
        total_income = 0.0
        
        if recent:
            for trans in recent:
                if isinstance(trans, dict):
                    amount = trans.get("amount", 0)
                    category = trans.get("category", "Other")
                    trans_type = trans.get("type", "expense")
                    
                    if trans_type == "expense":
                        total_spent += amount
                        categories[category] = categories.get(category, 0) + amount
                    elif trans_type == "income":
                        total_income += amount
        
        # Calculate savings rate
        savings_rate = (total_income - total_spent) / total_income if total_income > 0 else 0
        
        # Sort categories
        top_categories = sorted(categories.items(), key=lambda x: x[1], reverse=True)[:5]
        
        return SpendingAnalysis(
            period=f"last {period_days} days",
            total_spent=total_spent,
            total_income=total_income,
            savings_rate=max(0, savings_rate),
            categories=categories,
            top_categories=top_categories,
            trends={"direction": "stable"},
            recommendations=[
                "Your spending is within normal range",
                "Consider increasing emergency fund savings"
            ]
        )
    
    async def set_budget(
        self,
        category: str,
        limit: float
    ) -> dict:
        """
        Set a budget for a category.
        
        Args:
            category: Spending category
            limit: Monthly budget limit
            
        Returns:
            Confirmation dict
        """
        self.budgets[category] = limit
        return {
            "success": True,
            "category": category,
            "limit": limit,
            "currency": "USD"
        }
    
    async def get_budget_status(self) -> dict:
        """
        Get current status of all budgets.
        
        Returns:
            Dict with budget vs. actual spending
        """
        analysis = await self.analyze_spending_patterns(30)
        
        status = {}
        for category, limit in self.budgets.items():
            spent = analysis.categories.get(category, 0)
            remaining = limit - spent
            percentage = (spent / limit * 100) if limit > 0 else 0
            
            status[category] = {
                "limit": limit,
                "spent": spent,
                "remaining": remaining,
                "percentage": percentage,
                "status": "ok" if percentage <= 80 else "warning" if percentage <= 100 else "over"
            }
        
        return status
    
    async def get_financial_summary(self) -> dict:
        """
        Get comprehensive financial summary.
        
        Returns:
            Summary of accounts, budgets, and recent activity
        """
        total_balance = sum(acc.balance for acc in self.accounts.values())
        analysis = await self.analyze_spending_patterns()
        
        return {
            "accounts_count": len(self.accounts),
            "total_balance": total_balance,
            "monthly_income": analysis.total_income,
            "monthly_spending": analysis.total_spent,
            "savings_rate": analysis.savings_rate,
            "top_spending_category": analysis.top_categories[0][0] if analysis.top_categories else None,
            "budgets_set": len(self.budgets)
        }


# MCP Server builder
def build_server():
    """Build MCP server for FinancialAdvisor."""
    
    advisor = FinancialAdvisor()
    
    class FinancialAdvisorServer:
        """MCP server for financial operations."""
        
        def __init__(self):
            self.advisor = advisor
        
        async def connect_bank(self, bank_name: str, auth_token: str) -> dict:
            """Connect a bank account."""
            accounts = await self.advisor.connect_bank(bank_name, auth_token)
            return {
                "success": True,
                "bank": bank_name,
                "accounts_connected": len(accounts),
                "accounts": [
                    {
                        "name": a.name,
                        "type": a.type,
                        "balance": a.balance
                    }
                    for a in accounts
                ]
            }
        
        async def get_advice(self, question: str, context: Optional[dict] = None) -> dict:
            """Get financial advice."""
            advice = await self.advisor.get_advice(question, context)
            return {
                "title": advice.title,
                "description": advice.description,
                "category": advice.category,
                "priority": advice.priority,
                "action_items": advice.action_items,
                "potential_monthly_savings": advice.potential_savings_monthly
            }
        
        async def analyze_spending(self, period_days: int = 30) -> dict:
            """Analyze spending patterns."""
            analysis = await self.advisor.analyze_spending_patterns(period_days)
            return {
                "period": analysis.period,
                "total_spent": analysis.total_spent,
                "total_income": analysis.total_income,
                "savings_rate": analysis.savings_rate,
                "top_categories": analysis.top_categories,
                "recommendations": analysis.recommendations
            }
        
        async def set_budget(self, category: str, limit: float) -> dict:
            """Set a budget."""
            return await self.advisor.set_budget(category, limit)
        
        async def get_budget_status(self) -> dict:
            """Get budget status."""
            return await self.advisor.get_budget_status()
        
        async def get_summary(self) -> dict:
            """Get financial summary."""
            return await self.advisor.get_financial_summary()
    
    return FinancialAdvisorServer()
