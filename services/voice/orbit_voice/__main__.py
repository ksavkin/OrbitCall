"""`python -m orbit_voice start` (production) or `dev` (verbose): the livekit-agents CLI, plus /health."""

import logging
import os
import sys

if __name__ == "__main__":  # job processes (forkserver) import this module as __mp_main__: nothing runs there
    from .agent import main
    from .config import Config
    from .health import Health

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if len(sys.argv) > 1 and sys.argv[1] in ("start", "dev"):
        Health(Config()).serve()  # supervisor process only
    main()
