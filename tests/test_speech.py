from jarvis.speech import clean_for_speech


def test_strips_markdown_for_speech():
    text = "# Today\n- **Standup** at 9\n- Lunch with `Sam`\n\nSee [the doc](https://x.y/z)."
    assert clean_for_speech(text) == "Today. Standup at 9. Lunch with Sam. See the doc."


def test_replaces_code_and_bare_urls():
    spoken = clean_for_speech("Run this:\n```\nrm -rf /\n```\nor visit https://example.com")
    assert "rm -rf" not in spoken
    assert "on screen" in spoken
    assert "https" not in spoken


def test_blank_text_stays_blank():
    assert clean_for_speech("  \n ") == ""
