# services/voice — live translation worker

Python 3.12, LiveKit Agents (media only). Joins each coordination room `coordination-<roomId>` as `translator` by
explicit dispatch (`agent_name` `orbit-translator`; the call/join token's room configuration dispatches it when the
first member creates the room). One worker job per room.

## What it does per utterance
1. Subscribes only to human microphones (`user-*` identities, `SOURCE_MICROPHONE`); never its own or `host-*` tracks.
2. Grok STT streaming per speaker track (`wss://api.x.ai/v1/stt`, 16 kHz s16le, `format=true`, `endpointing` =
   `STT_ENDPOINTING_MS`, key terms from `orbit_voice/data/glossary.json`). Mute, unpublish or leave sends
   `audio.done` and closes the session; a dropped session reconnects with a new epoch.
3. Drops phrases written mostly in a script the speaker's language does not use (STT hallucination on noise).
4. zh only: spoken Han numerals become digits with the `cn2an` library; a single character turned into "1" is reverted
   so ordinary words that start with "one" stay intact.
5. Values (numbers with sign and unit, dates, times, durations, zones, designators) become placeholders
   `⟦v1⟧`, `⟦v2⟧`… (spec ProtectedValue). No word lists: the tokenizer reads ASCII digits and symbols, and a catch-all
   puts every remaining digit run in a placeholder.
6. One Claude call (`TRANSLATION_MODEL`, default `claude-sonnet-5-5`, structured JSON) translates into every other
   language present. Per language: every placeholder exactly once and no digit outside placeholders, else one retry
   for that language, then `original_only` with `errors[lang] = { code: "VALUE_CHECK_FAILED", message }`.
7. Rows to Convex `POST {CONVEX_SITE_URL}/call/phrase` (header `x-call-service-token`): rev 1 pending, rev 2 final,
   rev 3 only when a voice failed (`TTS_FAILED`, text stays `ok`). 4xx is logged and not retried; 5xx / network: one
   retry. `startedAtMs` is milliseconds from the call (LiveKit room) start.
8. Voice on track `tr:<lang>:<speakerIdentity>`, 24 kHz mono, in the speaker's voice gender: the participant
   attribute `voice` (`male` | `female`, signed into the join token by Convex; `TTS_DEFAULT_VOICE` otherwise). Cartesia
   (`CARTESIA_MODEL_ID`) with the ids `CARTESIA_VOICE_{EN,ZH}_{MALE,FEMALE}` for en/zh, Grok TTS with
   `XAI_TTS_VOICE_RU_{MALE,FEMALE}` for ru; `CARTESIA_VOICE_EN`, `CARTESIA_VOICE_ZH` and `XAI_TTS_VOICE_ID` are the
   fallback for both genders of their language. A language and gender without an id is text-only for that gender;
   there is no provider substitution and no cross-gender substitution.

## Run
```bash
pip install -r requirements.txt
python -m orbit_voice start          # production; `dev` for verbose logs
python -m orbit_voice.dispatch coordination-<roomId>       # dispatch by hand (tests, fallback)
python -m orbit_voice.smoke clip.wav en ru,zh              # providers only: STT -> values -> translate -> TTS timings
python -m orbit_voice.roomcheck <roomId> clip.wav en ru    # in-room check against a running worker (dev LiveKit)
```
`GET :8090/health` (`HEALTH_PORT`): `ready` = xAI (STT, Grok TTS) + Anthropic + every TTS provider a configured voice
uses + Convex settings + the worker registered in LiveKit (the agents worker's own endpoint on `WORKER_PORT`, default
8081); `voice` lists per language which genders are voiced (provider name or `text-only`); `degraded` for 60 s after a
run-time failure reported by a room job (`recentErrors`, last 5 min); `ok` = ready and not degraded (else 503). No keys
or voice ids in the answer. The Docker image runs as the unprivileged user `worker`. Docker: `docker build -t orbit-voice-worker .`.

## Environment
| Name | Default | Notes |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | | LiveKit server as seen from the worker |
| `LIVEKIT_AGENT_NAME` | `orbit-translator` | explicit dispatch name |
| `XAI_API_KEY` | | Grok STT and Grok TTS |
| `XAI_STT_MODEL` | `grok-voice-transcribe-2.0` | |
| `STT_ENDPOINTING_MS` | `400` | silence that ends an utterance |
| `STT_KEYTERMS` | glossary terms | comma list, up to 100 |
| `ANTHROPIC_API_KEY`, `TRANSLATION_MODEL` | `claude-sonnet-5-5` | |
| `CARTESIA_API_KEY`, `CARTESIA_MODEL_ID` | `sonic-3.6-2026-08-27` | |
| `CARTESIA_VOICE_EN_MALE`, `CARTESIA_VOICE_EN_FEMALE`, `CARTESIA_VOICE_ZH_MALE`, `CARTESIA_VOICE_ZH_FEMALE` | | Cartesia voice id per gender for en/zh; missing id → that gender falls back to the legacy id of its language, else text-only |
| `XAI_TTS_VOICE_RU_MALE`, `XAI_TTS_VOICE_RU_FEMALE` | | Grok voice id per gender for ru; missing id → that gender falls back to the legacy id, else text-only |
| `CARTESIA_VOICE_EN`, `CARTESIA_VOICE_ZH`, `XAI_TTS_VOICE_ID` | | legacy ids: fallback for both genders of the language |
| `TTS_DEFAULT_VOICE` | `female` | voice for a speaker with no `voice` attribute (`male` or `female`) |
| `CONVEX_SITE_URL`, `CALL_SERVICE_TOKEN` | | phrase ingest |
| `HEALTH_PORT`, `WORKER_PORT`, `LOG_LEVEL` | `8090`, `8081`, `INFO` | |
| `MAX_ROOMS` | `20` | load = active rooms / MAX_ROOMS (threshold 0.95) |

## Tests
`pip install -r requirements-dev.txt && python -m pytest -q` (129 cases, providers faked; no keys needed).

## Measured (2026-10-24, recorded clips, local LiveKit)
STT final 1.2–2.2 s after speech end; translation into two languages 2.4–4.2 s; voice first byte 0.8–1.5 s after the
translation; translated audio at a listener 5.8–6.6 s after the speaker stopped.

## Known limits
- Values the recognizer writes as words are not protected (Russian units arrive as words: the translator renders
  them; zh numerals are normalized; a lone zh "one" is not). Russian durations may arrive as clock times from STT formatting ("in 6 hours" became "06:00" in the live check): the value is carried verbatim, so the meaning changed at the STT step; operators see the original next to the translation.
- Values keep the speaker's notation (`0,2` stays `0,2` in an English translation).
- Placeholder order may change between languages (natural word order); a swap moves a value, never changes it.
- Translator-added number words (the prompt asks for digits only; the check is a backstop, no word lists of ours):
  detected are Mandarin numerals of two or more characters (cn2an), and in English and Russian numerals that the
  maintained `number-parser` library converts into two or more words or digits ("twenty six", "twelve",
  "dvadtsat pyat" spelled in Cyrillic) plus spelled decimals with one word between the parts ("zero point two",
  "nol tselykh dve desyatykh" in Cyrillic). Not detected (residual risk): a lone single word that becomes one digit in
  any language ("one", "six", a weekday or ordinal), and anything the library does not convert. A zh month or ordinal
  of two or more numeral characters (for a source that said it as a word, e.g. "November") is a false rejection and
  shows the original.
- Every rejection is logged with the failed check, the offending fragment and the (escaped) translation.

## Rows and failure codes
The stored `original` is the recognizer's text; zh normalization is used only for protection and translation.
`errors[lang].code`: `VALUE_CHECK_FAILED` (placeholders / digits / number words), `TOO_LONG` (translation over 2000
characters), `TOO_MANY_VALUES` (over 64 values: no translation), `UPSTREAM_UNAVAILABLE` (translation provider),
`PIPELINE_FAILED` (unexpected), all with `original_only`; `VOICE_UNAVAILABLE` (no voice id for that language and
gender) and `TTS_FAILED` keep the text `ok`. Playback is queued per track and never delays the next translation; a voice failure posts a later rev.
