"""A tiny MCP server for tests: one read-only tool and one that changes things."""

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations

server = MCPServer("demo")
NOTES = ["first note"]


@server.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_notes() -> str:
    """List the notes."""
    return "\n".join(NOTES)


@server.tool()
def add_note(text: str) -> str:
    """Add a note."""
    NOTES.append(text)
    return f"Added: {text}"


if __name__ == "__main__":
    server.run()
