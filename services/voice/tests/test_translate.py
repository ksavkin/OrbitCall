"""Translator (W2): per-language validation, one retry for failed languages only, malformed JSON isolated,
provider failures visible, parameter downgrades only on a parameter error. The Anthropic client is faked."""

import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from orbit_voice.translate import Translator, _parse, system_prompt
from orbit_voice.values import placeholder as V
from orbit_voice.values import protect


class FakeMessages:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=a)])


def translator(answers):
    msgs = FakeMessages(answers)
    return Translator("k", "claude-sonnet-5-5", client=SimpleNamespace(messages=msgs)), msgs


def bad_request(msg):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(msg, response=httpx.Response(400, request=req), body=None)


SRC = "burn 0.2 m/s at T-6h"
RU_OK = f"\u0438\u043c\u043f\u0443\u043b\u044c\u0441 {V(1)} \u0432 {V(2)}"
ZH_OK = f"\u5728{V(2)}\u70b9\u706b{V(1)}"


async def test_all_languages_pass_in_one_call():
    masked, values = protect(SRC)
    t, msgs = translator([json.dumps({"ru": RU_OK, "zh": ZH_OK})])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    assert set(out.texts) == {"ru", "zh"} and not out.errors
    assert "0.2 m/s" in out.texts["ru"] and "T-6h" in out.texts["zh"]
    call = msgs.calls[0]
    assert call["output_config"]["format"]["schema"]["required"] == ["ru", "zh"]
    assert call["thinking"] == {"type": "between_tools"} and call["model"] == "claude-sonnet-5-5"
    assert masked in call["messages"][0]["content"] and "0.2" not in call["messages"][0]["content"]


async def test_failed_language_is_retried_alone_then_original_only():
    masked, values = protect(SRC)
    zh_bad = f"\u5728{V(2)}\u70b9\u706b 5"  # dropped v1 and invented a digit
    t, msgs = translator([json.dumps({"ru": RU_OK, "zh": zh_bad}), json.dumps({"zh": zh_bad})])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    assert set(out.texts) == {"ru"}
    assert out.errors["zh"]["code"] == "VALUE_CHECK_FAILED"
    assert len(msgs.calls) == 2 and msgs.calls[1]["output_config"]["format"]["schema"]["required"] == ["zh"]
    assert "Previous attempt rejected" in msgs.calls[1]["messages"][0]["content"]


async def test_retry_can_recover_a_language():
    masked, values = protect(SRC)
    t, _ = translator([json.dumps({"ru": RU_OK, "zh": "x"}), json.dumps({"zh": ZH_OK})])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    assert set(out.texts) == {"ru", "zh"} and not out.errors


async def test_malformed_combined_json_falls_back_per_language():
    masked, values = protect(SRC)
    t, msgs = translator(['{"ru": "broken', json.dumps({"ru": RU_OK}), "not json at all", json.dumps({"zh": ZH_OK})])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    # combined malformed -> per-language calls: ru ok, zh malformed -> retried alone -> ok
    assert out.texts.keys() == {"ru", "zh"} and not out.errors
    assert [c["output_config"]["format"]["schema"]["required"] for c in msgs.calls][1:] in (
        [["ru"], ["zh"], ["zh"]], [["zh"], ["ru"], ["zh"]])


async def test_provider_failure_is_visible_for_every_language():
    masked, values = protect(SRC)
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    t, _ = translator([anthropic.APIConnectionError(request=req)])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    assert not out.texts and {e["code"] for e in out.errors.values()} == {"UPSTREAM_UNAVAILABLE"}


async def test_thinking_param_downgrade_only_on_parameter_error():
    masked, values = protect(SRC)
    t, msgs = translator([bad_request("thinking.type between_tools is not supported for this model"),
                          json.dumps({"ru": RU_OK})])
    out = await t.translate(masked, values, "en", ["ru"])
    assert out.texts.keys() == {"ru"} and "thinking" not in msgs.calls[1]
    assert "format" in msgs.calls[1]["output_config"]  # structured output kept


async def test_structured_output_downgrade_to_prompt_only():
    masked, values = protect(SRC)
    t, msgs = translator([bad_request("output_config.format: json_schema not supported"),
                          "Here you go: " + json.dumps({"ru": RU_OK})])
    out = await t.translate(masked, values, "en", ["ru"])
    assert out.texts.keys() == {"ru"} and "format" not in msgs.calls[1]["output_config"]


async def test_other_bad_request_is_a_visible_failure():
    masked, values = protect(SRC)
    t, msgs = translator([bad_request("max_tokens: too large")])
    out = await t.translate(masked, values, "en", ["ru"])
    assert out.errors["ru"]["code"] == "UPSTREAM_UNAVAILABLE" and len(msgs.calls) == 1


async def test_no_targets_no_call():
    t, msgs = translator([])
    out = await t.translate("hi", [], "en", [])
    assert not out.texts and not msgs.calls


def test_prompt_names_languages_and_rules():
    p = system_prompt("en", ["ru", "zh"])
    assert "Russian" in p and "Mandarin" in p and "exactly once" in p and "burn" in p


def test_parse_ignores_non_string_values():
    assert _parse('{"ru": 5, "zh": "x"}', ["ru", "zh"]) == {"zh": "x"}
    with pytest.raises(ValueError):
        _parse("[1, 2]", ["ru"])


async def test_zh_number_words_added_by_the_translator_are_rejected():
    masked, values = protect(SRC)
    zh_words = f"\u5728{V(2)}\u70b9\u706b{V(1)}\uff0c\u4e09\u5341\u516c\u91cc"  # adds "thirty kilometers" in Han numerals
    t, _ = translator([json.dumps({"zh": zh_words}), json.dumps({"zh": zh_words})])
    out = await t.translate(masked, values, "en", ["zh"])
    assert out.errors["zh"]["code"] == "VALUE_CHECK_FAILED"
    assert out.errors["zh"]["message"].startswith("number words outside the protected values")


async def test_zh_idioms_with_one_pass_the_number_word_check():
    masked, values = protect(SRC)
    zh = f"\u6211\u4eec\u4e00\u8d77\u5728{V(2)}\u70b9\u706b{V(1)}"  # "together": not a number
    t, _ = translator([json.dumps({"zh": zh})])
    out = await t.translate(masked, values, "en", ["zh"])
    assert out.texts.keys() == {"zh"} and not out.errors


async def test_zh_weekday_and_ordinal_pass_but_multi_char_numerals_fail():
    masked, values = protect(SRC)
    weekday = f"\u5230\u5468\u4e09\u6210\u50cf\u65f6\uff0c\u6211\u4eec\u5728{V(2)}\u7b2c\u4e00\u6b21\u70b9\u706b{V(1)}"
    t, _ = translator([json.dumps({"zh": weekday})])
    out = await t.translate(masked, values, "en", ["zh"])
    assert out.texts.keys() == {"zh"} and not out.errors  # Wednesday and "first time" are words, not added numbers
    added = f"\u5728{V(2)}\u70b9\u706b{V(1)}\uff0c\u96f6\u70b9\u4e8c\u516c\u91cc"  # adds "zero point two km"
    t, _ = translator([json.dumps({"zh": added}), json.dumps({"zh": added})])
    out = await t.translate(masked, values, "en", ["zh"])
    assert out.errors["zh"]["code"] == "VALUE_CHECK_FAILED" and "number words" in out.errors["zh"]["message"]


async def test_provider_outage_on_the_retry_is_upstream_not_value_check():
    masked, values = protect(SRC)
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    t, _ = translator([json.dumps({"ru": RU_OK, "zh": "bad"}), anthropic.APIConnectionError(request=req)])
    out = await t.translate(masked, values, "en", ["ru", "zh"])
    assert out.texts.keys() == {"ru"} and out.errors["zh"]["code"] == "UPSTREAM_UNAVAILABLE"


async def test_too_long_translation_is_rejected_with_its_own_code():
    masked, values = protect(SRC)
    long = f"{V(1)} {V(2)} " + "x" * 2100
    t, _ = translator([json.dumps({"ru": long}), json.dumps({"ru": long})])
    out = await t.translate(masked, values, "en", ["ru"])
    assert out.errors["ru"]["code"] == "TOO_LONG"


@pytest.mark.parametrize("lang, text, flagged", [
    ("en", f"burn {V(1)} at {V(2)}, about twenty five km away", True),
    ("en", f"one of them burns {V(1)} at {V(2)}, the second one waits", False),
    ("en", f"burn {V(1)} at {V(2)} in twelve hours", True),
    ("ru", f"\u0438\u043c\u043f\u0443\u043b\u044c\u0441 {V(1)} \u0432 {V(2)}, \u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044c \u043f\u044f\u0442\u044c \u043a\u043c", True),
    ("ru", f"\u043e\u0434\u0438\u043d \u0438\u0437 \u043d\u0438\u0445 \u0434\u0430\u0451\u0442 \u0438\u043c\u043f\u0443\u043b\u044c\u0441 {V(1)} \u0432 {V(2)}", False),

    ("en", f"burn {V(1)} at {V(2)}, about zero point two more", True),  # spelled decimal: two spans one word apart
    ("ru", f"\u0438\u043c\u043f\u0443\u043b\u044c\u0441 {V(1)} \u0432 {V(2)}, \u0435\u0449\u0451 \u043d\u043e\u043b\u044c \u0446\u0435\u043b\u044b\u0445 \u0434\u0432\u0435 \u0434\u0435\u0441\u044f\u0442\u044b\u0445", True),
    ("en", f"burn {V(1)} at {V(2)} in six hours", False),  # documented residual: a lone single-digit word
])
async def test_en_ru_number_words_via_library(lang, text, flagged):
    masked, values = protect(SRC)
    t, _ = translator([json.dumps({lang: text}), json.dumps({lang: text})])
    out = await t.translate(masked, values, "ru" if lang == "en" else "en", [lang])
    assert (lang in out.errors) is flagged
