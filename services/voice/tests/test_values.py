"""Value protection corpus (W1): en / ru / zh inputs (non-Latin text as \\u escapes), every digit run protected,
sign and unit folded into the value, ranges as two values."""

import re

import pytest

from orbit_voice.values import OPEN, PLACEHOLDER, ProtectedValue, check, placeholder, protect, restore

V = placeholder


def kinds(text):
    masked, values = protect(text)
    return masked, [(v.kind, v.text) for v in values]


@pytest.mark.parametrize("text, masked, values", [
    ("We can burn 0.2 m/s six hours before TCA.", f"We can burn {V(1)} six hours before TCA.", [("unit", "0.2 m/s")]),
    ("Burn at T-6h, 0.2 m/s prograde.", f"Burn at {V(1)}, {V(2)} prograde.", [("datetime", "T-6h"), ("unit", "0.2 m/s")]),
    ("T-12 h before", f"{V(1)} before", [("datetime", "T-12 h")]),
    ("T+02:13 after the burn", f"{V(1)} after the burn", [("datetime", "T+02:13")]),
    ("TCA is 2026-10-25T03:14:07Z, miss 0.18 km.", f"TCA is {V(1)}, miss {V(2)}.",
     [("datetime", "2026-10-25T03:14:07Z"), ("unit", "0.18 km")]),
    ("Meet at 03:14 UTC or 14:00Z", f"Meet at {V(1)} or {V(2)}", [("datetime", "03:14 UTC"), ("datetime", "14:00Z")]),
    ("UTC+3 ok, offset +03:00.", f"{V(1)} ok, offset {V(2)}.", [("timezone", "UTC+3"), ("timezone", "+03:00")]),
    ("on 25.10.2026 or 10/25/26", f"on {V(1)} or {V(2)}", [("datetime", "25.10.2026"), ("datetime", "10/25/26")]),
    ("STARLINK-33969 vs SIM-0001", f"{V(1)} vs {V(2)}", [("object_id", "STARLINK-33969"), ("object_id", "SIM-0001")]),
    ("COSMOS 2553, FENGYUN-1C debris", f"{V(1)}, {V(2)} debris", [("object_id", "COSMOS 2553"), ("object_id", "FENGYUN-1C")]),
    ("NUSAT-39 at 6 h", f"{V(1)} at {V(2)}", [("object_id", "NUSAT-39"), ("unit", "6 h")]),
    ("Range 5-10 km", f"Range {V(1)}-{V(2)}", [("number", "5"), ("unit", "10 km")]),
    ("delta -0.05 m/s", f"delta {V(1)}", [("unit", "-0.05 m/s")]),
    ("delta \u22120,05 m/s", f"delta {V(1)}", [("unit", "\u22120,05 m/s")]),
    ("Pc 2.1e-4, 1e-4 km", f"Pc {V(1)}, {V(2)}", [("number", "2.1e-4"), ("unit", "1e-4 km")]),
    ("45deg, 30%, 3rev/day, 12kg", f"{V(1)}, {V(2)}, {V(3)}, {V(4)}",
     [("unit", "45deg"), ("unit", "30%"), ("unit", "3rev/day"), ("unit", "12kg")]),
    ("1,000 km and 2 to 5 satellites", f"{V(1)} and {V(2)} to {V(3)} satellites",
     [("unit", "1,000 km"), ("number", "2"), ("number", "5")]),
    ("3 satellites in 2 orbits", f"{V(1)} satellites in {V(2)} orbits", [("number", "3"), ("number", "2")]),
    ("5 s and 6 hours", f"{V(1)} and {V(2)} hours", [("unit", "5 s"), ("number", "6")]),
    # ru: decimal comma, units spoken as words stay text (the translator renders them)
    ("\u041c\u043e\u0436\u0435\u043c 0,2 \u043c/\u0441 \u0437\u0430 6 \u0447\u0430\u0441\u043e\u0432.",
     f"\u041c\u043e\u0436\u0435\u043c {V(1)} \u043c/\u0441 \u0437\u0430 {V(2)} \u0447\u0430\u0441\u043e\u0432.",
     [("number", "0,2"), ("number", "6")]),
    # zh after numeral normalization
    ("\u6211\u4eec\u57286\u5c0f\u65f6\u540e\u70b9\u706b0.2\u7c73\u6bcf\u79d2",
     f"\u6211\u4eec\u5728{V(1)}\u5c0f\u65f6\u540e\u70b9\u706b{V(2)}\u7c73\u6bcf\u79d2", [("number", "6"), ("number", "0.2")]),
    ("no values here", "no values here", []),
])
def test_corpus(text, masked, values):
    assert kinds(text) == (masked, values)


@pytest.mark.parametrize("text", [
    "a1b2c3", "x99y", "ISS 25544 and 49044", "v2.3.4", "1/2", "07:5", "A-1-2-3", "\u0661\u0662 and 12", "T-", "-", "0",
    "2026-10-25 03:14 UTC+3", "pass at 06:00 GMT+3", "0.2m/s", "\u0438\u0437 3 \u0432 4",
])
def test_no_ascii_digit_survives(text):
    masked, values = protect(text)
    assert not re.search(r"\d", PLACEHOLDER.sub("", masked)), masked
    assert restore(masked, values) == text


def test_restore_reorders_values():
    masked, values = protect("burn 0.2 m/s at T-6h")
    moved = f"{V(2)}: {V(1)} burn"
    assert check(moved, values) is None
    assert restore(moved, values) == "T-6h: 0.2 m/s burn"


@pytest.mark.parametrize("translation, reason", [
    (f"burn {V(1)} at", "placeholder \u27e6v2\u27e7 appears 0 times"),
    (f"burn {V(1)} {V(1)} {V(2)}", "placeholder \u27e6v1\u27e7 appears 2 times"),
    (f"burn {V(1)} {V(2)} {V(3)}", "unknown placeholder \u27e6v3\u27e7"),
    (f"burn {V(1)} {V(2)} plus 5", "a digit outside the protected values"),
    (f"burn {V(1)} {V(2)} \uff15", "a digit outside the protected values"),  # full-width digit
    (f"burn {V(1)} {OPEN}v 2\u27e7", "placeholder \u27e6v2\u27e7 appears 0 times"),
    (f"burn {V(1)} {V(2)} {OPEN}x", "a placeholder was altered"),
])
def test_check_rejects(translation, reason):
    _, values = protect("burn 0.2 m/s at T-6h")
    assert check(translation, values) == reason


def test_check_accepts_ru_and_zh_translations():
    _, values = protect("We can burn 0.2 m/s 6 h before TCA")
    ru = f"\u041c\u043e\u0436\u0435\u043c \u0441\u0434\u0435\u043b\u0430\u0442\u044c \u0438\u043c\u043f\u0443\u043b\u044c\u0441 {V(1)} \u0437\u0430 {V(2)} \u0434\u043e TCA"
    zh = f"\u6211\u4eec\u53ef\u4ee5\u5728TCA\u524d{V(2)}\u70b9\u706b{V(1)}"
    assert check(ru, values) is None and check(zh, values) is None
    assert "0.2 m/s" in restore(ru, values) and "6 h" in restore(zh, values)


def test_value_json_is_spec_shape():
    _, values = protect("0.2 m/s")
    assert values[0].as_json() == {"placeholder": "\u27e6v1\u27e7", "kind": "unit", "text": "0.2 m/s"}
    assert isinstance(values[0], ProtectedValue)
