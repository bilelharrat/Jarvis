"""Adapters for "Bring over from…" (code_import): one module per coding tool, each with a
SOURCE (detect → scan → read_chat). Every adapter only reads the tool's files, never writes
them, and fails soft: a file it can't read is one "couldn't read" item, never a crash."""
