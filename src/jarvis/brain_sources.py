"""The rebuild's finishing step for the second brain (brain_build): with search by meaning on
(args["more"]["semantic"], from jarvis.features.brain), vectors for the passages that have
none yet, then the galaxy's links by meaning (jarvis.embeddings). It runs in the rebuild's
own low-priority process, under its lock, before the index is saved. Nothing here calls
Claude or goes online.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

SEMANTIC = ("brain_semantic", False)  # search by meaning: may download Apple's model files
VECTORS = "vectors"  # rebuild_brain(only={VECTORS}): re-read nothing, make vectors


def finisher(args: dict[str, Any]) -> Callable[[Any, Callable[[str], None]], None] | None:
    """With search by meaning on: vectors for the new passages, then links by meaning."""
    more = args.get("more") if isinstance(args.get("more"), dict) else {}
    if not more.get("semantic"):
        return None

    def finish(kb: Any, progress: Callable[[str], None]) -> None:
        from . import embeddings, swift_helper

        def make() -> embeddings.Embedder | None:
            binary = swift_helper.ensure(embeddings.HELPER)
            return embeddings.HelperEmbedder(binary) if binary is not None else None

        progress("Search by meaning: finding what's new…")
        vectors, rows = embeddings.embed_index(
            kb.notes, kb.built_at, embeddings.vectors_path(kb.store), make, progress
        )
        links, with_vectors = embeddings.note_links(vectors, rows, len(kb.notes))
        if links:
            kb.edges = embeddings.merged_links(kb.edges, links, with_vectors)
            kb._galaxy = None

    return finish
