# OrbitCall orbital service: code only. The data folder (ORBIT_DATA=/service/data) is a persistent volume prepared by
# setup-data.sh: the team's pinned OMM and SOCRATES snapshots (snapshots/gp-*, snapshots/socrates-*), the TLE groups,
# replay, cached validation, plus jobs/ and sim/ written at runtime. The tests read the same folder.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    ORBIT_DATA=/service/data ORBIT_CATALOG_MODE=omm ORBIT_SERVICE_TOKEN=""
WORKDIR /service/src
COPY src/requirements.txt ./
RUN pip install --root-user-action=ignore -r requirements.txt
COPY src/ ./
EXPOSE 3610
# One process: the catalog lives in memory, jobs run in its thread pool and /simulate changes the catalog.
CMD ["python", "-m", "uvicorn", "orbit.app:app", "--host", "0.0.0.0", "--port", "3610", "--workers", "1"]
