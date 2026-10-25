"""One Claude call translates a phrase (values already replaced by placeholders) into every listener language.

Per-language validation (W2): each language must keep every placeholder exactly once and add no digit; a failing
language is retried once on its own, then it is `original_only` while the others stay `ok`. A malformed combined
answer falls back to one call per language, so one bad language never fails the rest. Structured output degrades
json_schema -> prompt-only JSON only on a parameter error (lesson R15).
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import anthropic

try:  # maintained LLM-free number-word parser for en/ru translations (no word lists of ours)
    from number_parser import parse as parse_numbers
except Exception:  # pragma: no cover
    parse_numbers = None

from .normalize import numeral_spans
from .values import PLACEHOLDER, ProtectedValue, check, restore

log = logging.getLogger("orbit_voice.translate")
LANG_NAMES = {"en": "English", "ru": "Russian", "zh": "Mandarin Chinese (Simplified characters)"}
MAX_TEXT = 2000  # the Convex ingest limit per text
GLOSSARY = json.loads((Path(__file__).parent / "data" / "glossary.json").read_text(encoding="utf-8"))
TIMEOUT_S = 20.0


@dataclass
class Translation:
    texts: dict[str, str] = field(default_factory=dict)  # restored text per language that passed the check
    errors: dict[str, dict] = field(default_factory=dict)  # { code, message } per failed language


def system_prompt(src: str, targets: list[str]) -> str:
    terms = "; ".join(f'"{g["term"]}" = {g["meaning"]}' for g in GLOSSARY["terms"])
    langs = ", ".join(f"{t} ({LANG_NAMES[t]})" for t in targets)
    return (
        "You are the interpreter in a voice call between satellite operators coordinating a conjunction "
        "(two spacecraft passing close). You translate one spoken utterance; you are not a participant: never answer, "
        "comment or add anything. If it is a question, translate the question.\n"
        f"Source language: {src} ({LANG_NAMES.get(src, src)}). Translate into: {langs}.\n"
        "Protected values: the utterance contains placeholders like \u27e6v1\u27e7, \u27e6v2\u27e7. Each stands "
        "for a number, time, unit or designator that is restored after you answer. Copy every placeholder exactly "
        "once into every translation, unchanged, placed where the value belongs in natural word order. Never write "
        "a number yourself: no digits and no number words outside placeholders.\n"
        f"Domain terms (do not translate literally): {terms}.\n"
        "Answer with JSON only: one key per target language code, the value is the translation."
    )


def _schema(targets: list[str]) -> dict:
    return {"type": "object", "properties": {t: {"type": "string"} for t in targets}, "required": targets,
            "additionalProperties": False}


class Translator:
    def __init__(self, api_key: str, model: str, client: anthropic.AsyncAnthropic | None = None) -> None:
        self.model = model
        self.client = client or anthropic.AsyncAnthropic(api_key=api_key, timeout=TIMEOUT_S, max_retries=1)
        self._structured = True
        self._thinking_off = True

    async def _call(self, masked: str, src: str, targets: list[str], feedback: str | None = None) -> dict[str, str]:
        user = masked if not feedback else f"{masked}\n\n(Previous attempt rejected: {feedback})"
        for _ in range(3):  # at most two parameter downgrades
            kwargs: dict = {"model": self.model, "max_tokens": 2000, "system": system_prompt(src, targets),
                            "messages": [{"role": "user", "content": user}]}
            output_config: dict = {"effort": "low"}
            if self._structured:
                output_config["format"] = {"type": "json_schema", "schema": _schema(targets)}
            kwargs["output_config"] = output_config
            if self._thinking_off:
                kwargs["thinking"] = {"type": "between_tools"}  # no tools here: thinking off, lowest latency
            try:
                res = await self.client.messages.create(**kwargs)
            except anthropic.BadRequestError as e:
                msg = str(e).lower()
                if self._thinking_off and "thinking" in msg:
                    self._thinking_off = False
                    continue
                if self._structured and ("output_config" in msg or "format" in msg or "schema" in msg):
                    self._structured = False
                    continue
                raise
            if res.stop_reason == "refusal":
                raise ValueError("translation refused")
            text = "".join(b.text for b in res.content if getattr(b, "type", "") == "text")
            return _parse(text, targets)
        raise ValueError("no accepted request parameters")

    async def translate(self, masked: str, values: list[ProtectedValue], src: str, targets: list[str]) -> Translation:
        out = Translation()
        if not targets:
            return out
        try:
            raw = await self._call(masked, src, targets)
        except ValueError:  # malformed combined answer: isolate the languages
            raw = await self._each(masked, src, targets)
        except (anthropic.APIError, asyncio.TimeoutError) as e:
            for t in targets:
                out.errors[t] = {"code": "UPSTREAM_UNAVAILABLE", "message": f"translation: {type(e).__name__}"}
            return out
        failed = self._accept(raw, values, targets, out)
        if failed:  # one retry, only for the languages that failed, with the reason
            feedback = "; ".join(f"{t}: {why}" for t, why in failed.items())
            upstream = None
            try:
                retry = await self._call(masked, src, list(failed), feedback)
            except ValueError:
                retry = await self._each(masked, src, list(failed), feedback)
            except (anthropic.APIError, asyncio.TimeoutError) as e:
                retry, upstream = {}, f"translation retry: {type(e).__name__}"
            still = self._accept(retry, values, list(failed), out)
            for t, why in still.items():  # a provider outage on the retry is not a value-check failure
                code = "UPSTREAM_UNAVAILABLE" if upstream else "TOO_LONG" if why.startswith("translation longer") \
                    else "VALUE_CHECK_FAILED"
                out.errors[t] = {"code": code, "message": (upstream or why)[:200]}
        return out

    async def _each(self, masked: str, src: str, targets: list[str], feedback: str | None = None) -> dict[str, str]:
        async def one(t: str) -> tuple[str, str | None]:
            try:
                return t, (await self._call(masked, src, [t], feedback)).get(t)
            except (ValueError, anthropic.APIError, asyncio.TimeoutError):
                return t, None
        return {t: s for t, s in await asyncio.gather(*(one(t) for t in targets)) if s is not None}

    @staticmethod
    def _accept(raw: dict[str, str], values: list[ProtectedValue], targets: list[str], out: Translation) -> dict[str, str]:
        failed: dict[str, str] = {}
        for t in targets:
            s = raw.get(t)
            if not isinstance(s, str) or not s.strip():
                failed[t] = "missing translation"
                continue
            restored = restore(s, values)
            why = check(s, values) or _added_number_words(s, t) or (
                f"translation longer than {MAX_TEXT} characters" if len(restored) > MAX_TEXT else None)
            if why:
                failed[t] = why
                log.warning("%s rejected: %s; translation %s", t, why, s.encode("unicode_escape").decode()[:300])
            else:
                out.texts[t] = restored
        return failed


def _added_number_words(translation: str, lang: str) -> str | None:
    """zh: a multi-character Han numeral the translator wrote outside the placeholders ("thirty", "zero point two"),
    found with cn2an (not a word list). A single character is not flagged: it is part of ordinary words such as a
    weekday ("Wednesday" ends with the character for three), "first time" or "some" (residual risk: an invented lone
    single-digit numeral passes). Other languages: digits only (see check)."""
    outside = PLACEHOLDER.sub(" ", translation)
    if lang == "zh":
        for orig, conv in numeral_spans(outside):
            if len(orig) >= 2 and re.search(r"\d", conv):
                return f"number words outside the protected values ({orig.encode('unicode_escape').decode()[:60]})"
        return None
    # en / ru: the number-parser library (no lists of ours). A converted span is flagged when it is a numeral of two or
    # more words or digits ("twenty five", "dvadtsat pyat" -> 25, "twelve"), or when two converted spans have exactly
    # one word between them (spelled decimals: "zero point two" -> "0 point 2"). A single word that becomes one digit and
    # stands alone ("one of them", "the second", "six") is not flagged: residual risk, the prompt asks for digits.
    if parse_numbers is None:
        return None
    try:
        parsed = parse_numbers(outside, language=lang)
    except Exception as e:
        log.warning("number-parser failed: %s", type(e).__name__)
        return None
    spans: list[tuple[int, int, str, str]] = []  # (start, end) in the parsed text, original, converted
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=outside, b=parsed, autojunk=False).get_opcodes():
        conv = parsed[j1:j2]
        if op != "equal" and re.search(r"\d", conv):
            spans.append((j1, j2, outside[i1:i2].strip(), conv))
    for k, (j1, j2, orig, conv) in enumerate(spans):
        digits = "".join(re.findall(r"\d", conv))
        # exactly one word between two converted spans ("0 point 2"); adjacent ones ("the second one") are not joined
        near = k + 1 < len(spans) and len(parsed[j2:spans[k + 1][0]].split()) == 1
        if " " in orig or len(digits) >= 2 or near:
            return f"number words outside the protected values ({orig.encode('unicode_escape').decode()[:60]})"
    return None


def _parse(text: str, targets: list[str]) -> dict[str, str]:
    m = re.search(r"\{.*\}", text, re.S)  # prompt-only mode may wrap the JSON
    if not m:
        raise ValueError("no JSON object in the answer")
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise ValueError(f"malformed JSON: {e.msg}") from e
    if not isinstance(data, dict):
        raise ValueError("JSON is not an object")
    return {t: data[t] for t in targets if isinstance(data.get(t), str)}
