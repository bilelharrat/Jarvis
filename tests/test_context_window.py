"""The context window Jarvis Code shows: sized for the session's model, broken down by what
fills it, with when it compacts."""

import pytest

from jarvis.providers import context_window
from jarvis.tasks import shape_context


@pytest.mark.parametrize(
    ("model", "tokens"),
    [
        ("google/gemini-1.5-pro", 2_000_000),
        ("google/gemini-2.5-pro", 1_048_576),
        ("gemini-3-pro-preview", 1_048_576),
        ("openai/gpt-5", 400_000),
        ("openai/gpt-4.1-mini", 1_047_576),
        ("openai/o3", 200_000),
        ("x-ai/grok-4-fast", 2_000_000),
        ("x-ai/grok-4", 256_000),
        ("meta-llama/llama-4-scout", 10_000_000),
        ("deepseek/deepseek-r1", 128_000),
    ],
)
def test_other_providers_models_have_their_own_windows(model, tokens):
    assert context_window(model) == tokens


@pytest.mark.parametrize(
    "model", ["claude-opus-5-5", "anthropic/claude-sonnet-5-5", "", None, "acme/mystery-1"]
)
def test_claude_and_unknown_models_use_what_claude_code_reports(model):
    assert context_window(model) is None


USAGE = {
    "categories": [
        {"name": "System prompt", "tokens": 3_000, "color": "x"},
        {"name": "Messages", "tokens": 97_000, "color": "y"},
        {"name": "MCP tools", "tokens": 0, "color": "z"},
        {"name": "Deferred tools", "tokens": 5_000, "color": "z", "isDeferred": True},
        {"name": "Free space", "tokens": 80_000, "color": "w"},
        {"name": "Autocompact buffer", "tokens": 20_000, "color": "w"},
    ],
    "totalTokens": 100_000,
    "maxTokens": 180_000,
    "rawMaxTokens": 200_000,
    "percentage": 55.6,
    "isAutoCompactEnabled": True,
    "autoCompactThreshold": 160_000,
}


def test_a_claude_session_shows_claude_codes_window():
    shown = shape_context(USAGE, "claude-opus-5-5")
    assert shown["max"] == 200_000 and shown["percent"] == 50 and shown["tokens"] == 100_000
    assert [c["name"] for c in shown["categories"]] == ["System prompt", "Messages"]
    assert shown["autocompact"] is True and shown["compact_at"] == 80


def test_a_gemini_session_shows_geminis_window():
    shown = shape_context(USAGE, "google/gemini-1.5-pro")
    assert shown["max"] == 2_000_000 and shown["percent"] == 5
