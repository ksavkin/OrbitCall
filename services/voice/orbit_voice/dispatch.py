"""`python -m orbit_voice.dispatch <roomName>`: dispatch the translator to a room explicitly (e2e and fallback;
normally the call/join token's room configuration dispatches it when the room is created)."""

import asyncio
import sys

from livekit import api

from .agent import http_url
from .config import Config


async def dispatch(room: str) -> str:
    cfg = Config()
    lk = api.LiveKitAPI(http_url(cfg.livekit_url), cfg.livekit_api_key, cfg.livekit_api_secret)
    try:
        d = await lk.agent_dispatch.create_dispatch(api.CreateAgentDispatchRequest(agent_name=cfg.agent_name, room=room))
        return d.id
    finally:
        await lk.aclose()


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].startswith("coordination-"):
        sys.exit("usage: python -m orbit_voice.dispatch coordination-<roomId>")
    print(asyncio.run(dispatch(sys.argv[1])))
