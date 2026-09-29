'use strict';

// What one Jarvis Code message may carry. A file is counted the moment it's picked, not
// when it has been read: a drop, paste or multi-select hands over every file at once, and
// counting only the ones already read let ten 5 MB photos past a 24 MB limit and over the
// window socket's 64 MiB frame (the socket closed, and the message and files were lost).
(function (root) {
  const LIMITS = {
    files: 6, // the backend takes six
    total: 24_000_000, // base64 or text characters in one message, far under the frame
    binary: 6_000_000, // one picture or PDF, in bytes
    text: 400_000, // one text file, in bytes
  };

  // Characters a file adds to the message: base64 for pictures and PDFs, its text otherwise.
  function cost(kind, size) {
    return kind === 'text' ? size : Math.ceil(size / 3) * 4;
  }

  // held: [{ kind, size }] for files attached or still being read. '' when this one fits,
  // otherwise why not: 'files' | 'size' | 'total'.
  function check(held, kind, size, limits = LIMITS) {
    if (held.length >= limits.files) return 'files';
    if (size > (kind === 'text' ? limits.text : limits.binary)) return 'size';
    const used = held.reduce((n, f) => n + cost(f.kind, f.size), 0);
    return used + cost(kind, size) > limits.total ? 'total' : '';
  }

  const api = { LIMITS, cost, check };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisAttach = api;
})(typeof window === 'object' ? window : globalThis);
