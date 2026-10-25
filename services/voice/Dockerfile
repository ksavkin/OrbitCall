# OrbitCall translation worker (team repo: services/voice/). Keys come from the environment at run time.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt \
    && useradd --create-home --uid 10001 worker
COPY orbit_voice ./orbit_voice
USER worker
EXPOSE 8090
CMD ["python", "-m", "orbit_voice", "start"]
