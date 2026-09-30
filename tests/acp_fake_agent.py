"""A fake ACP agent for the tests (tests/test_code_acp.py): JSON-RPC 2.0 over stdin and
stdout, a message a line, as a real agent speaks it. What it does depends on the prompt:

  hello  thinks, then says "Hello there." in two chunks
  run    asks to run `npm install left-pad` (session/request_permission); runs it if allowed
  plan   sends a plan of three steps
  wait   works until the client cancels (session/cancel), then stops "cancelled"
  crash  exits at once, saying why on stderr
  noisy  prints a line that isn't JSON first, then answers

It never touches the network or any file. FAKE_ACP_AUTH=1 makes session/new ask for a
sign-in; FAKE_ACP_LOG=<path> keeps every message it got there.
"""

import json
import os
import sys

SESSION = "sess-1"
logged = open(os.environ["FAKE_ACP_LOG"], "a") if os.environ.get("FAKE_ACP_LOG") else None  # noqa: SIM115
waiting: dict = {}  # its own request ids -> the response, once it came
cancelled = False


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def update(what, **fields):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": SESSION, "update": {"sessionUpdate": what, **fields}},
        }
    )


def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    message = json.loads(line)
    if logged:
        logged.write(line)
        logged.flush()
    return message


def ask(method, params, request_id):
    """A request of its own, and the client's answer (reading on meanwhile)."""
    global cancelled
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    while True:
        message = read()
        if message.get("id") == request_id and "method" not in message:
            return message
        if message.get("method") == "session/cancel":
            cancelled = True


def prompt(text):
    global cancelled
    if "crash" in text:
        sys.stderr.write("fake agent: something broke\n")
        sys.stderr.flush()
        sys.exit(3)
    if "hello" in text:
        update("agent_thought_chunk", content={"type": "text", "text": "Thinking…"})
        update("agent_message_chunk", content={"type": "text", "text": "Hello "})
        update("agent_message_chunk", content={"type": "text", "text": "there."})
    if "run" in text:
        call = {
            "toolCallId": "t1",
            "title": "npm install",
            "kind": "execute",
            "status": "pending",
            "rawInput": {"command": "npm install left-pad"},
        }
        update("tool_call", **call)
        options = [
            {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
            {"optionId": "always", "name": "Always", "kind": "allow_always"},
            {"optionId": "no", "name": "Reject", "kind": "reject_once"},
        ]
        answer = ask(
            "session/request_permission",
            {"sessionId": SESSION, "toolCall": call, "options": options},
            "p1",
        )
        outcome = (answer.get("result") or {}).get("outcome") or {}
        if outcome.get("optionId") == "yes":
            update("tool_call_update", toolCallId="t1", status="completed",
                   content=[{"type": "content", "content": {"type": "text", "text": "added 1 package"}}])  # fmt: skip
            update("agent_message_chunk", content={"type": "text", "text": "Installed."})
        else:
            update("tool_call_update", toolCallId="t1", status="failed")
            update(
                "agent_message_chunk",
                content={"type": "text", "text": f"Not allowed ({outcome.get('outcome')})."},
            )
    if "plan" in text:
        update("plan", entries=[
            {"content": "Read the code", "priority": "high", "status": "completed"},
            {"content": "Fix the bug", "priority": "high", "status": "in_progress"},
            {"content": "Run the tests", "priority": "medium", "status": "pending"},
        ])  # fmt: skip
    if "wait" in text:
        update("agent_message_chunk", content={"type": "text", "text": "Working"})
        while not cancelled:
            message = read()
            if message.get("method") == "session/cancel":
                cancelled = True
        cancelled = False
        return "cancelled"
    return "end_turn"


def main():
    while True:
        message = read()
        method, request_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            result = {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": True},
                "authMethods": [],
            }
        elif method == "session/new":
            if os.environ.get("FAKE_ACP_AUTH"):
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32000, "message": "Authentication required"},
                    }
                )
                continue
            result = {"sessionId": SESSION}
        elif method == "session/load":
            update(
                "user_message_chunk", content={"type": "text", "text": "an old message"}
            )  # (replayed history)
            result = None
        elif method == "session/prompt":
            text = " ".join(
                b.get("text", "") for b in params.get("prompt") or [] if isinstance(b, dict)
            )
            if "noisy" in text:
                sys.stdout.write("this line is a log, not a message\n")
            result = {"stopReason": prompt(text)}
        elif method == "session/cancel":
            continue
        elif request_id is not None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": "not here"},
                }
            )
            continue
        else:
            continue
        send({"jsonrpc": "2.0", "id": request_id, "result": result})


if __name__ == "__main__":
    main()
