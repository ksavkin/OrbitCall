"""Chinese spoken numbers: Grok STT keeps Han numerals for zh even with `format=true`, so they would escape value
protection. For zh speech only, the maintained `cn2an` library converts numerals to digits before tokenizing (no
word lists of ours). If the library is missing or fails, the text is left as is and the phrase stays unprotected
for those numbers (reported by `normalize`).

One rule keeps idioms intact without a word list: a single character converted to "1" is reverted, because the
character for one starts many ordinary words ("some", "together", "must"). A lone spoken "one" therefore stays
unprotected (measured in the live check)."""

from __future__ import annotations

import difflib
import logging

log = logging.getLogger("orbit_voice.normalize")

try:  # optional dependency
    import cn2an  # type: ignore[import-untyped]
except Exception:  # pragma: no cover - exercised when the wheel is absent
    cn2an = None


def normalize(text: str, lang: str) -> tuple[str, bool]:
    """(text, changed). Only zh is normalized; other languages arrive with digits from the recognizer."""
    if lang != "zh" or cn2an is None or not text:
        return text, False
    try:
        out = cn2an.transform(text, "cn2an")
    except Exception as e:  # the library raises on odd input; never lose the phrase
        log.warning("cn2an failed: %s", type(e).__name__)
        return text, False
    out = _keep_idioms(text, out)
    return out, out != text


def numeral_spans(text: str) -> list[tuple[str, str]]:
    """(original, converted) spans raw cn2an would change in a zh text (no idiom rule: callers decide which spans
    count); [] when nothing changes or the library fails (logged)."""
    if cn2an is None or not text:
        return []
    try:
        after = cn2an.transform(text, "cn2an")
    except Exception as e:
        log.warning("cn2an failed on a translation: %s", type(e).__name__)
        return []
    return [(text[i1:i2], after[j1:j2]) for op, i1, i2, j1, j2 in
            difflib.SequenceMatcher(a=text, b=after, autojunk=False).get_opcodes() if op != "equal"]


def _keep_idioms(before: str, after: str) -> str:
    parts: list[str] = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if op == "equal":
            parts.append(before[i1:i2])
        elif op == "replace" and i2 - i1 == 1 and after[j1:j2] == "1":
            parts.append(before[i1:i2])
        else:
            parts.append(after[j1:j2])
    return "".join(parts)
