"""runproc's own pieces apart from the processes it runs (test_devservers has those): what a
stream's end holds as it's read."""

import asyncio

from jarvis import runproc


async def test_only_the_end_of_a_stream_is_held_as_it_is_read():
    """runproc.stream_tail (the brain rebuild's traceback; through output_end, a "!"
    command's last words): however much comes, only the bytes asked for are kept."""
    whole = b"".join(f"line {n}\n".encode() for n in range(5000))
    stream = asyncio.StreamReader()
    stream.feed_data(whole)
    stream.feed_eof()
    assert await runproc.stream_tail(stream, 20) == whole[-20:]
    assert await runproc.stream_tail(None, 20) == b""
    stream = asyncio.StreamReader()
    stream.feed_data("修复 bug ".encode() * 1000)
    stream.feed_eof()
    end = await runproc.output_end(stream, 7)
    assert end.endswith("修复 bug ") and len(end) <= 7 * 4 + 4  # (the bytes 7 can take)
