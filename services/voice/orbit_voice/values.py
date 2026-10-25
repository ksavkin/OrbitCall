"""Protected values without word lists (spec section 2 ProtectedValue, LANG-2).

Every number, time, date, duration, timezone and object designator in the recognized text is replaced by an opaque
placeholder before translation and restored verbatim after it, so a translation can move a value but never change it.
The tokenizer only looks at ASCII digits and ASCII symbols: no per-language number words. A final catch-all rule
puts every remaining ASCII digit run inside a placeholder, so after restoring, any digit left outside a placeholder in
a translation was added by the translator, and that language is rejected.

The sign (+, -, U+2212) and an attached unit are folded into the value's text: there is no standalone sign value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

OPEN, CLOSE = "\u27e6", "\u27e7"  # the spec's placeholder brackets
PLACEHOLDER = re.compile(OPEN + r"v(\d+)" + CLOSE)
MINUS = "\u2212"
_SIGN = rf"[+\-{MINUS}]"
# A sign counts only at the start of a value, never between two digits ("5-10" is a range of two values).
_SIGNED = rf"(?:(?<![\w.,]){_SIGN})?"
_NUM = r"\d+(?:[.,]\d+)*"
# Units after a space must look like a unit symbol (ASCII letters with / or ^, or SI-style symbols); a unit glued to
# the number may be any ASCII letters ("12km", "3rev/day"). This list is units, not words of a language.
_SPACED_UNIT = (r"(?:[A-Za-z]+(?:[/^][A-Za-z0-9]+)+|min|deg|rad|rev|dB|AU|"
                r"(?:k|c|m|M|G)?(?:m|s|g|Hz|N|W|J|Pa|t)|h|d|K)(?![A-Za-z0-9/^])")
_GLUED_UNIT = r"(?:[A-Za-z]+(?:[/^][A-Za-z0-9]+)*|\u00b0[CF]?|%)"
_UNIT = rf"(?:{_GLUED_UNIT}|\s(?:{_SPACED_UNIT}|\u00b0[CF]?|%))"
_TZ = rf"(?:Z|UTC|GMT)(?:{_SIGN}\d{{1,2}}(?::?\d{{2}})?)?"
_OFFSET = rf"{_SIGN}\d{{2}}:?\d{{2}}"

_RULES: list[tuple[str, str]] = [
    # 2026-10-25, 2026-10-25T03:14:07Z, 2026-10-25 03:14 UTC+3
    ("datetime", rf"\d{{4}}-\d{{2}}-\d{{2}}(?:[T ]\d{{1,2}}:\d{{2}}(?::\d{{2}}(?:\.\d+)?)?)?(?:\s?{_TZ}|{_OFFSET})?(?![\d])"),
    # 25.10.2026, 10/25/26
    ("datetime", r"(?<![\d.])\d{1,2}[./]\d{1,2}[./]\d{2,4}(?![\d.])"),
    # mission-relative durations: T-6h, T+02:13, T-12 h
    ("datetime", rf"(?<![A-Za-z0-9])T{_SIGN}\d+(?::\d{{2}}){{0,2}}(?:\s?(?:min|h|m|s|d))?(?![A-Za-z0-9])"),
    # clock times with an optional zone: 03:14, 3:14:07 UTC, 14:00Z, 06:00 GMT+3
    ("datetime", rf"(?<![\d:])\d{{1,2}}:\d{{2}}(?::\d{{2}})?(?:\s?{_TZ}|{_OFFSET})?(?![\d:])"),
    # zones alone: UTC, UTC+3, GMT-05:00, +03:00
    ("timezone", rf"(?<![A-Za-z0-9])(?:UTC|GMT){_SIGN}\d{{1,2}}(?::?\d{{2}})?(?![\d])"),
    ("timezone", rf"(?<![\w:]){_OFFSET}(?![\d:])"),
    # designators: STARLINK-1234, SIM-0001, NUSAT-39, FENGYUN-1C, COSMOS 2553
    ("object_id", r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*-\d+[A-Za-z]?(?![A-Za-z0-9])"),
    ("object_id", r"(?<![A-Za-z0-9])[A-Z]{3,}\s\d{3,}(?!\d|[.,]\d)"),
    # scientific notation before plain numbers, so "2.1e-4" is not read as "2.1" + unit "e"
    ("unit", rf"{_SIGNED}\d+(?:[.,]\d+)?[eE][+\-]?\d+{_UNIT}"),
    ("number", rf"{_SIGNED}\d+(?:[.,]\d+)?[eE][+\-]?\d+(?![\d])"),
    # numbers with an optional sign and unit: 0.2 m/s, -0,05, 1,000 km, 45deg, 30%
    ("unit", rf"{_SIGNED}{_NUM}{_UNIT}"),
    ("number", rf"{_SIGNED}{_NUM}"),
    # catch-all: any digit run left over (keeps the "no digit outside placeholders" check meaningful)
    ("number", r"\d+"),
]
_COMPILED = [(kind, re.compile(rx)) for kind, rx in _RULES]


@dataclass(frozen=True)
class ProtectedValue:
    placeholder: str
    kind: str  # "number" | "unit" | "datetime" | "timezone" | "object_id" | "sign"
    text: str

    def as_json(self) -> dict:
        return {"placeholder": self.placeholder, "kind": self.kind, "text": self.text}


def placeholder(n: int) -> str:
    return f"{OPEN}v{n}{CLOSE}"


def protect(text: str) -> tuple[str, list[ProtectedValue]]:
    """Replaces values by placeholders, leftmost first; at one position the first rule in order wins."""
    values: list[ProtectedValue] = []
    out: list[str] = []
    i = 0
    while i < len(text):
        best: tuple[int, int, str] | None = None
        for kind, rx in _COMPILED:
            m = rx.search(text, i)
            if m and m.end() > m.start() and (best is None or m.start() < best[0]):
                best = (m.start(), m.end(), kind)
        if best is None:
            out.append(text[i:])
            break
        start, end, kind = best
        value = text[start:end].rstrip()
        end = start + len(value)
        out.append(text[i:start])
        ph = placeholder(len(values) + 1)
        values.append(ProtectedValue(ph, kind, value))
        out.append(ph)
        i = end
    return "".join(out), values


def restore(translation: str, values: list[ProtectedValue]) -> str:
    by_ph = {v.placeholder: v.text for v in values}
    return PLACEHOLDER.sub(lambda m: by_ph.get(m.group(0), m.group(0)), translation)


def check(translation: str, values: list[ProtectedValue]) -> str | None:
    """None when the translation keeps every value exactly once and adds none; else the reason."""
    wanted = {v.placeholder for v in values}
    seen: dict[str, int] = {}
    for m in PLACEHOLDER.finditer(translation):
        seen[m.group(0)] = seen.get(m.group(0), 0) + 1
    unknown = sorted(set(seen) - wanted)
    if unknown:
        return f"unknown placeholder {unknown[0]}"
    for ph in sorted(wanted, key=lambda p: int(PLACEHOLDER.fullmatch(p).group(1))):  # type: ignore[union-attr]
        if seen.get(ph, 0) != 1:
            return f"placeholder {ph} appears {seen.get(ph, 0)} times"
    rest = PLACEHOLDER.sub("", translation)
    if OPEN in rest or CLOSE in rest:
        return "a placeholder was altered"
    if re.search(r"\d", rest):  # any Unicode digit, incl. full-width: a number the source did not protect
        return "a digit outside the protected values"
    return None
