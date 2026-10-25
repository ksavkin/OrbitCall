"""In-room check of a running worker without a browser:
`python -m orbit_voice.roomcheck <roomId> <clip.wav> <speakerLang> <listenerLang>`.

A listener joins `coordination-<roomId>` with `lang=<listenerLang>`, the translator is dispatched, a speaker joins with
`lang=<speakerLang>` and publishes the 16 kHz mono WAV as its microphone. The listener subscribes only to
`tr:<listenerLang>:<speaker>` and reports when translated audio arrives. Needs LIVEKIT_URL / KEY / SECRET (local dev
server credentials); prints no secrets."""

from __future__ import annotations

import asyncio
import sys
import time
import wave
from array import array

from livekit import api, rtc

from .config import Config
from .dispatch import dispatch
from .player import track_name


def token(cfg: Config, room: str, identity: str, lang: str) -> str:
    return (api.AccessToken(cfg.livekit_api_key, cfg.livekit_api_secret).with_identity(identity).with_name(identity)
            .with_attributes({"lang": lang, "companyId": f"check-{lang}"})
            .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True,
                                         can_publish_data=False)).to_jwt())


async def main(room_id: str, path: str, src: str, dst: str) -> int:
    cfg = Config()
    room_name = f"coordination-{room_id}"
    speaker_id, listener_id = f"user-check-{src}", f"user-check-{dst}"
    want = track_name(dst, speaker_id)
    listener, speaker = rtc.Room(), rtc.Room()
    heard: dict[str, float] = {}
    seen_tracks: list[str] = []
    translator = asyncio.Event()

    def on_published(pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        seen_tracks.append(f"{p.identity}/{pub.name}")
        if pub.name == want:
            pub.set_subscribed(True)

    def on_subscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        async def listen() -> None:
            async for ev in rtc.AudioStream(track, sample_rate=24000, num_channels=1):
                samples = array("h", bytes(ev.frame.data))
                if samples and max(abs(s) for s in samples) > 500:
                    heard.setdefault("first", time.monotonic())
                    heard["last"] = time.monotonic()
                    heard["frames"] = heard.get("frames", 0) + 1
        asyncio.create_task(listen())

    listener.on("track_published", on_published)
    listener.on("track_subscribed", on_subscribed)
    listener.on("participant_connected", lambda p: translator.set() if p.identity == "translator" else None)
    await listener.connect(cfg.livekit_url, token(cfg, room_name, listener_id, dst), rtc.RoomOptions(auto_subscribe=False))
    if not any(p.identity == "translator" for p in listener.remote_participants.values()):
        await dispatch(room_name)
    await asyncio.wait_for(translator.wait(), 20)
    print(f"translator joined {room_name}")

    w = wave.open(path)
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
    pcm = w.readframes(w.getnframes())
    await speaker.connect(cfg.livekit_url, token(cfg, room_name, speaker_id, src), rtc.RoomOptions(auto_subscribe=False))
    source = rtc.AudioSource(16000, 1)
    opts = rtc.TrackPublishOptions()
    opts.source = rtc.TrackSource.SOURCE_MICROPHONE
    await speaker.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track("microphone", source), opts)
    await asyncio.sleep(1.0)  # let the translator subscribe before speech starts
    step = 320 * 2
    for i in range(0, len(pcm), step):
        chunk = pcm[i:i + step].ljust(step, b"\0")
        await source.capture_frame(rtc.AudioFrame(chunk, 16000, 1, 320))
    for _ in range(100):  # 2 s of silence: endpointing
        await source.capture_frame(rtc.AudioFrame(b"\0" * step, 16000, 1, 320))
    spoke_end = time.monotonic() - 2.0
    for _ in range(300):
        if "last" in heard and time.monotonic() - heard["last"] > 2.0:
            break
        await asyncio.sleep(0.1)
    print(f"tracks seen by the listener: {sorted(set(seen_tracks))}")
    if "first" in heard:
        print(f"translated audio on {want}: first sound {(heard['first'] - spoke_end) * 1000:.0f} ms after speech end, "
              f"{heard['frames'] * 0.01:.1f} s non-silent")
    else:
        print(f"NO translated audio on {want}")
    await speaker.disconnect()
    await listener.disconnect()
    return 0 if "first" in heard else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(*sys.argv[1:5])))
