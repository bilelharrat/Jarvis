"""Equations in words, for a researcher who listens to papers: MathML (as Europe PMC's full texts
carry it, inside <inline-formula> and <disp-formula>) and, when a formula has no MathML, its TeX,
turned into sentences a speech voice can read: "x squared plus y squared equals r squared", "the
fraction a plus b over c, end fraction", "the square root of 2", "the sum from i equals 1 to n
of x sub i".

It covers the common constructs (fractions, powers, subscripts, roots, sums, integrals, Greek
letters, the usual operators and relations); anything else is read as its symbols. When there is
neither MathML nor TeX, the formula's alt text (or its plain characters) is used.

Claude cost policy: no model call; pure text work on the article the owner asked for.
"""

from __future__ import annotations

import re
from typing import Any

MATHML = "{http://www.w3.org/1998/Math/MathML}"

GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ϵ": "epsilon",
    "ζ": "zeta", "η": "eta", "θ": "theta", "ϑ": "theta", "ι": "iota", "κ": "kappa",
    "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma",
    "ς": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi",
    "ω": "omega", "Γ": "capital gamma", "Δ": "capital delta", "Θ": "capital theta",
    "Λ": "capital lambda", "Ξ": "capital xi", "Π": "capital pi", "Σ": "capital sigma",
    "Υ": "capital upsilon", "Φ": "capital phi", "Ψ": "capital psi", "Ω": "capital omega",
}

OPERATORS = {
    "+": "plus", "-": "minus", "−": "minus", "–": "minus", "±": "plus or minus",
    "∓": "minus or plus", "×": "times", "·": "times", "⋅": "times", "∗": "times", "*": "times",
    "÷": "divided by", "/": "over", "=": "equals", "≠": "is not equal to", "<": "is less than",
    ">": "is greater than", "≤": "is less than or equal to", "≥": "is greater than or equal to",
    "⩽": "is less than or equal to", "⩾": "is greater than or equal to",
    "≈": "is approximately", "≃": "is approximately", "≅": "is congruent to", "∼": "is similar to",
    "~": "is similar to", "≡": "is equivalent to", "∝": "is proportional to", "≪": "is much less than",
    "≫": "is much greater than", "→": "goes to", "←": "comes from", "⇒": "implies",
    "⇔": "if and only if", "↔": "if and only if", "∈": "in", "∉": "not in", "⊂": "subset of",
    "⊆": "subset of or equal to", "∪": "union", "∩": "intersection", "∀": "for all",
    "∃": "there exists", "∞": "infinity", "∂": "partial", "∇": "nabla", "∑": "sum",
    "∏": "product", "∫": "integral", "∮": "contour integral", "√": "square root of",
    "%": "percent", "°": "degrees", "′": "prime", "'": "prime", "″": "double prime",
    "!": "factorial", "|": "bar", "∥": "parallel to", "⊥": "perpendicular to",
    "…": "and so on", "⋯": "and so on", "∘": "composed with", "⊗": "tensor", "⊕": "direct sum",
    "¬": "not", "∧": "and", "∨": "or", "ℏ": "h bar", "∅": "the empty set",
    "(": "open paren", ")": "close paren", "[": "open bracket", "]": "close bracket",
    "{": "open brace", "}": "close brace", "⟨": "open angle", "⟩": "close angle",
    ",": ",", ";": ";", ":": "such that",
    "\u2061": "", "\u2062": "", "\u2063": "",  # (MathML's invisible function application, times, comma)
}

# Large operators said "the sum from … to … of …".
BIG = {"∑": "the sum", "∏": "the product", "∫": "the integral", "∮": "the contour integral",
       "⋃": "the union", "⋂": "the intersection", "lim": "the limit", "max": "the maximum",
       "min": "the minimum"}

ACCENTS = {"^": "hat", "ˆ": "hat", "¯": "bar", "‾": "bar", "~": "tilde", "˜": "tilde",
           "˙": "dot", "¨": "double dot", "→": "vector", "⃗": "vector"}


def _local(tag: Any) -> str:
    return str(tag).rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _sym(text: str) -> str:
    """One token's characters in words: Greek letters and operators named, the rest kept."""
    text = text.strip()
    if not text:
        return ""
    if text in OPERATORS:
        return OPERATORS[text]
    if len(text) > 1 and not any(c in GREEK or c in OPERATORS for c in text):
        return text  # a number, a word, a function name (sin, log)
    out = []
    for c in text:
        if c in GREEK:
            out.append(GREEK[c])
        elif c in OPERATORS:
            out.append(OPERATORS[c])
        elif c.strip():
            out.append(c)
    return " ".join(w for w in out if w)


def _join(parts: list[str]) -> str:
    text = " ".join(p for p in parts if p and p.strip())
    text = re.sub(r"\s+([,;])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def _simple(node: Any) -> bool:
    """A single token (x, 2, alpha), safe to say without "end fraction" and the like."""
    tag = _local(node.tag)
    if tag in ("mi", "mn", "mtext"):
        return True
    if tag in ("mrow", "mstyle", "mpadded", "semantics") and len(node) == 1:
        return _simple(node[0])
    return False


def _power(base: str, simple: bool, exp: str) -> str:
    if exp == "2":
        return f"{base} squared"
    if exp == "3":
        return f"{base} cubed"
    if exp in ("prime", "double prime"):
        return f"{base} {exp}"
    if exp == "T":
        return f"{base} transpose"
    if not simple:
        return f"{base} to the power {exp}, end power"
    return f"{base} to the power {exp}"


def _children(node: Any) -> list[Any]:
    return [c for c in node if _local(c.tag) not in ("annotation", "annotation-xml", "none", "mprescripts")]


def mathml_words(node: Any) -> str:
    """A MathML element (math or any part of it) said in words."""
    tag = _local(node.tag)
    kids = _children(node)
    if tag in ("mi", "mn", "mtext", "ms"):
        return _sym("".join(node.itertext()))
    if tag == "mo":
        return _sym("".join(node.itertext()))
    if tag == "mspace" or tag == "mphantom" or tag == "malignmark":
        return ""
    if tag == "semantics":
        return mathml_words(kids[0]) if kids else ""
    if tag == "mfrac":
        if len(kids) < 2:
            return _row(kids)
        top, bottom = mathml_words(kids[0]), mathml_words(kids[1])
        if node.get("linethickness") in ("0", "0pt", "0px"):
            return f"{top} choose {bottom}"
        if _simple(kids[0]) and _simple(kids[1]):
            return f"{top} over {bottom}"
        return f"the fraction {top} over {bottom}, end fraction"
    if tag == "msqrt":
        inner = _row(kids)
        return f"the square root of {inner}" + ("" if len(kids) == 1 and _simple(kids[0]) else ", end root")
    if tag == "mroot":
        if len(kids) < 2:
            return _row(kids)
        index = mathml_words(kids[1])
        name = {"2": "square", "3": "cube"}.get(index, f"{index}th")
        return f"the {name} root of {mathml_words(kids[0])}" + ("" if _simple(kids[0]) else ", end root")
    if tag in ("msup", "msub", "msubsup", "munder", "mover", "munderover"):
        return _scripts(tag, kids)
    if tag == "mfenced":
        opening, closing = node.get("open", "("), node.get("close", ")")
        inner = _join([mathml_words(k) for k in kids])
        return _join([_sym(opening), inner, _sym(closing)])
    if tag == "mtable":
        rows = [mathml_words(r) for r in kids]
        return "; ".join(r for r in rows if r)
    if tag in ("mtr", "mlabeledtr"):
        return ", ".join(w for w in (mathml_words(c) for c in kids) if w)
    if tag == "mmultiscripts":
        return _row(kids[:1]) + (" with scripts " + _row(kids[1:]) if len(kids) > 1 else "")
    return _row(kids)  # math, mrow, mstyle, mpadded, menclose, mtd, merror, and the unknown


def _row(kids: list[Any]) -> str:
    """A row of tokens; a large operator followed by its scripts reads "the sum from … to … of …"."""
    parts: list[str] = []
    for i, kid in enumerate(kids):
        said = mathml_words(kid)
        parts.append(said)
        tag = _local(kid.tag)
        # A function name followed by its argument: "sin of x", "log of n".
        if tag == "mi" and said in ("sin", "cos", "tan", "log", "ln", "exp", "sinh", "cosh", "tanh") and i + 1 < len(kids):
            parts.append("of")
    return _join(parts)


def _scripts(tag: str, kids: list[Any]) -> str:
    if not kids:
        return ""
    base_node = kids[0]
    base_text = "".join(base_node.itertext()).strip()
    base = mathml_words(base_node)
    lower = upper = None
    if tag in ("msub", "munder") and len(kids) > 1:
        lower = kids[1]
    elif tag in ("msup", "mover") and len(kids) > 1:
        upper = kids[1]
    elif len(kids) > 2:
        lower, upper = kids[1], kids[2]
    low = mathml_words(lower) if lower is not None else ""
    up = mathml_words(upper) if upper is not None else ""
    if base_text in BIG:
        return _big_said(BIG[base_text], low, up)
    if tag == "mover" and upper is not None and "".join(upper.itertext()).strip() in ACCENTS:
        return f"{base} {ACCENTS[''.join(upper.itertext()).strip()]}"
    if tag == "munder" and lower is not None:
        return f"{base} under {low}"
    said = base
    if low:
        said = f"{said} sub {low}" + ("" if lower is None or _simple(lower) else ", end sub")
    if up:
        said = _power(said, upper is None or _simple(upper), up)
    return said


# ── TeX, for formulas that carry no MathML ──

TEX_GREEK = {name: name for name in (
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi "
    "pi rho sigma tau upsilon phi varphi chi psi omega").split()}
TEX_GREEK.update({"varepsilon": "epsilon", "vartheta": "theta", "varphi": "phi"})
TEX_GREEK.update({n: f"capital {n.lower()}" for n in "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split()})

TEX_OPS = {
    "times": "times", "cdot": "times", "div": "divided by", "pm": "plus or minus", "mp": "minus or plus",
    "leq": "is less than or equal to", "le": "is less than or equal to", "geq": "is greater than or equal to",
    "ge": "is greater than or equal to", "neq": "is not equal to", "ne": "is not equal to",
    "approx": "is approximately", "sim": "is similar to", "simeq": "is approximately", "equiv": "is equivalent to",
    "propto": "is proportional to", "ll": "is much less than", "gg": "is much greater than",
    "to": "goes to", "rightarrow": "goes to", "leftarrow": "comes from", "Rightarrow": "implies",
    "Leftrightarrow": "if and only if", "in": "in", "notin": "not in", "subset": "subset of",
    "subseteq": "subset of or equal to", "cup": "union", "cap": "intersection", "forall": "for all",
    "exists": "there exists", "infty": "infinity", "partial": "partial", "nabla": "nabla",
    "ldots": "and so on", "cdots": "and so on", "dots": "and so on", "prime": "prime", "circ": "composed with",
    "otimes": "tensor", "oplus": "direct sum", "neg": "not", "land": "and", "lor": "or", "hbar": "h bar",
    "emptyset": "the empty set", "perp": "perpendicular to", "parallel": "parallel to", "mid": "given",
    "lbrace": "open brace", "rbrace": "close brace", "langle": "open angle", "rangle": "close angle",
    "{": "open brace", "}": "close brace", "%": "percent", ",": "", ";": "", ":": "", "!": "", " ": "",
    "quad": "", "qquad": "", "left": "", "right": "", "big": "", "Big": "", "bigg": "", "Bigg": "",
    "displaystyle": "", "textstyle": "", "limits": "", "nolimits": "",
}
TEX_FUNCS = {"sin", "cos", "tan", "log", "ln", "exp", "sinh", "cosh", "tanh", "det", "arg"}
TEX_BIG = {"sum": "the sum", "prod": "the product", "int": "the integral", "oint": "the contour integral",
           "lim": "the limit", "max": "the maximum", "min": "the minimum", "bigcup": "the union", "bigcap": "the intersection"}
TEX_ACCENTS = {"hat": "hat", "bar": "bar", "overline": "bar", "tilde": "tilde", "widetilde": "tilde",
               "widehat": "hat", "dot": "dot", "ddot": "double dot", "vec": "vector"}
TEX_TEXT = {"mathrm", "text", "textrm", "mathit", "mathbf", "boldsymbol", "mathsf", "operatorname", "mathcal", "mathbb", "textit", "textbf"}


def _tex_body(tex: str) -> str:
    """The formula itself out of Europe PMC's TeX (often a whole little document)."""
    m = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", tex, re.S)
    if m:
        tex = m.group(1)
    tex = re.sub(r"\\(begin|end)\{(equation|align|eqnarray|gather|displaymath|math)\*?\}", " ", tex)
    tex = tex.replace("$$", " ").replace("$", " ").replace("\\[", " ").replace("\\]", " ")
    return tex.strip()


def _tex_tokens(tex: str) -> list[str]:
    return re.findall(r"\\[A-Za-z]+|\\.|[{}^_]|\d+(?:\.\d+)?|[A-Za-z]|\S", tex)


class _TeX:
    def __init__(self, tokens: list[str]) -> None:
        self.t = tokens
        self.i = 0

    def peek(self) -> str:
        return self.t[self.i] if self.i < len(self.t) else ""

    def take(self) -> str:
        tok = self.peek()
        self.i += 1
        return tok

    def group(self) -> tuple[str, bool]:
        """The next argument ({…} or one token), said; and whether it was a single token."""
        if self.peek() == "{":
            self.take()
            start = self.i
            said = self.row(until="}")
            simple = self.i - start <= 2
            if self.peek() == "}":
                self.take()
            return said, simple
        return self.atom(), True

    def optional(self) -> str:
        if self.peek() != "[":
            return ""
        self.take()
        parts = []
        while self.peek() and self.peek() != "]":
            parts.append(self.atom())
        self.take()
        return _join(parts)

    def atom(self) -> str:
        tok = self.take()
        if not tok:
            return ""
        if tok == "{":
            said = self.row(until="}")
            self.take()
            return said
        if not tok.startswith("\\"):
            return _sym(tok)
        name = tok[1:]
        if name == "frac" or name in ("dfrac", "tfrac"):
            top, a = self.group()
            bottom, b = self.group()
            return f"{top} over {bottom}" if a and b else f"the fraction {top} over {bottom}, end fraction"
        if name == "sqrt":
            index = self.optional()
            inner, simple = self.group()
            root = {"": "square", "2": "square", "3": "cube"}.get(index, f"{index}th")
            return f"the {root} root of {inner}" + ("" if simple else ", end root")
        if name in TEX_TEXT:
            if self.peek() == "{":  # a word set in roman (CO, max, ReLU): read as written
                end = self.t.index("}", self.i) if "}" in self.t[self.i:] else -1
                plain = self.t[self.i + 1 : end] if end > 0 else []
                if plain and all(re.fullmatch(r"[A-Za-z0-9.]", tok) for tok in plain):
                    self.i = end + 1
                    return "".join(plain)
            inner, _ = self.group()
            return inner
        if name in TEX_ACCENTS:
            inner, _ = self.group()
            return f"{inner} {TEX_ACCENTS[name]}"
        if name in TEX_GREEK:
            return TEX_GREEK[name]
        if name in TEX_OPS:
            return TEX_OPS[name]
        if name in TEX_FUNCS:
            return f"{name} of"
        if name in TEX_BIG:
            return "\x00" + name  # its scripts come next: see row()
        return name

    def row(self, until: str = "") -> str:
        parts: list[str] = []
        while self.peek() and self.peek() != until:
            if self.peek() in ("^", "_"):
                parts.append(self.scripts(parts.pop() if parts else ""))
                continue
            if self.peek() == "}":  # an unmatched brace
                self.take()
                continue
            parts.append(self.atom())
        return _join([self.big(p) for p in parts])

    def big(self, part: str) -> str:
        return _big_said(TEX_BIG[part[1:]], "", "") if part.startswith("\x00") else part

    def scripts(self, base: str) -> str:
        low = up = ""
        low_simple = up_simple = True
        while self.peek() in ("^", "_"):
            mark = self.take()
            said, simple = self.group()
            if mark == "_":
                low, low_simple = said, simple
            else:
                up, up_simple = said, simple
        if base.startswith("\x00"):
            return _big_said(TEX_BIG[base[1:]], low, up)
        said = base
        if low:
            said = f"{said} sub {low}" + ("" if low_simple else ", end sub")
        if up:
            said = _power(said, up_simple, up)
        return said


def _big_said(name: str, low: str, up: str) -> str:
    if low and up:
        return f"{name} from {low} to {up} of"
    if low:
        return f"{name} over {low} of"
    if up:
        return f"{name} to {up} of"
    return f"{name} of"


def tex_words(tex: str) -> str:
    """A TeX formula said in words (the common constructs; the rest as its symbols)."""
    body = _tex_body(tex)
    if not body:
        return ""
    try:
        return _TeX(_tex_tokens(body)).row()
    except Exception:  # a formula too odd to parse: its characters, at least
        return re.sub(r"\s+", " ", body)


# ── a JATS formula element ──


def formula_words(node: Any) -> str:
    """An <inline-formula>, <disp-formula> or bare MathML <math> said in words: its MathML, else
    its TeX, else its alt text, else its characters."""
    tag = _local(node.tag)
    if tag == "math":
        said = mathml_words(node)
        return said or _alt(node)
    for el in node.iter():
        if _local(el.tag) == "math":
            said = mathml_words(el)
            if said:
                return said
            break
    for el in node.iter():
        if _local(el.tag) == "tex-math":
            said = tex_words("".join(el.itertext()))
            if said:
                return said
    return _alt(node)


def _alt(node: Any) -> str:
    for el in node.iter():
        if el.get("alttext"):
            return str(el.get("alttext")).strip()
        if _local(el.tag) == "alt-text" and "".join(el.itertext()).strip():
            return re.sub(r"\s+", " ", "".join(el.itertext())).strip()
    text = "".join("".join(el.itertext()) + (el.tail or "") for el in node if _local(el.tag) != "label")
    return re.sub(r"\s+", " ", (node.text or "") + text).strip()


def label_of(node: Any) -> str:
    for el in node:
        if _local(el.tag) == "label":
            return re.sub(r"[()\s]", "", "".join(el.itertext()))
    return ""
