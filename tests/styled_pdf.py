"""A small real PDF with type of different sizes and weights, for the tests that guess headings."""

from __future__ import annotations


def styled_pdf(pages: list[list[tuple[str, int, str]]]) -> bytes:
    """A page per entry, each a list of lines (font, size, text): F1 is Helvetica, F2 Helvetica-Bold."""
    objs: list[bytes | None] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        None,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    kids = []
    for lines in pages:
        y, ops = 740, []
        for font, size, text in lines:
            words = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"BT /{font} {size} Tf 72 {y} Td ({words}) Tj ET")
            y -= size + 8
        stream = "\n".join(ops).encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content = len(objs)
        objs.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>" % content
        )
        kids.append(len(objs))
    refs = b" ".join(b"%d 0 R" % k for k in kids)
    objs[1] = b"<< /Type /Pages /Kids [" + refs + b"] /Count %d >>" % len(kids)
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + (obj or b"") + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


BODY = "This is body text that goes on for a while about the study and its data."

PAPER = [
    [
        ("F1", 22, "A Study of Things"),
        ("F1", 11, BODY),
        ("F2", 16, "1 Introduction"),
        ("F1", 11, BODY),
        ("F1", 11, BODY),
        ("F1", 11, "Figure 1. Growth of things over time"),
    ],
    [
        ("F2", 16, "2 Methods"),
        ("F1", 11, BODY),
        ("F2", 11, "Sampling"),
        ("F1", 11, BODY),
        ("F1", 11, "Table 1: Sample sizes"),
    ],
    [("F2", 16, "3 Results"), ("F1", 11, "The results were good."), ("F1", 11, BODY)],
]
