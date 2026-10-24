FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts ./scripts
COPY migrations ./migrations
COPY alembic.ini .
RUN sed -i 's/\r$//' scripts/*.sh && chmod +x scripts/entrypoint.sh && useradd -m hads && chown -R hads /srv
USER hads
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 CMD curl -fs http://localhost:8000/api/ready || exit 1
# migrate, then exec uvicorn (scripts/entrypoint.sh)
CMD ["./scripts/entrypoint.sh"]
