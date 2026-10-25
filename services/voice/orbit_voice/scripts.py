"""Foreign-script guard (lesson R9): a multilingual recognizer can hallucinate whole phrases in a script the speaker
never uses (on silence or noise). Script detection uses Unicode character names, not word lists.
"""

from __future__ import annotations

import unicodedata

# Scripts a speaker of each language writes; Latin is always allowed (designators, units, brand names).
EXPECTED = {"en": {"LATIN"}, "ru": {"LATIN", "CYRILLIC"}, "zh": {"LATIN", "CJK"}}


def _script(ch: str) -> str | None:
    if not ch.isalpha():
        return None
    name = unicodedata.name(ch, "")
    for script in ("LATIN", "CYRILLIC", "CJK", "HIRAGANA", "KATAKANA", "HANGUL", "ARABIC", "HEBREW", "GREEK",
                   "DEVANAGARI", "THAI", "ARMENIAN", "GEORGIAN"):
        if name.startswith(script):
            return script
    return "OTHER"


def foreign_share(text: str, lang: str) -> float:
    """Share of letters written in a script the language does not use (0 when there are no letters)."""
    expected = EXPECTED.get(lang, {"LATIN"})
    scripts = [s for s in (_script(c) for c in text) if s]
    if not scripts:
        return 0.0
    return sum(1 for s in scripts if s not in expected) / len(scripts)


def plausible(text: str, lang: str, max_foreign: float = 0.5) -> bool:
    """False for an empty phrase or one mostly in a foreign script (dropped, never translated or voiced)."""
    return bool(text.strip()) and foreign_share(text, lang) <= max_foreign
