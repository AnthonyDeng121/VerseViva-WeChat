FROM node:24-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY shared/ /app/shared/
RUN npm run build

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VERSEVIVA_ENV=production \
    VERSEVIVA_DATA_DIR=/app/data \
    VERSEVIVA_WEB_DIST_DIR=/app/web/dist \
    VERSEVIVA_DEMUCS_EXECUTABLE=/opt/verseviva/demucs/bin/demucs \
    VERSEVIVA_WHISPERX_EXECUTABLE=/opt/verseviva/whisperx/bin/whisperx \
    VERSEVIVA_FFPROBE_EXECUTABLE=ffprobe

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-demucs.txt requirements-whisperx.txt requirements-whisperx-cpu.txt ./

# Keep the large, rarely changed model environments independent from application
# source so ordinary backend edits can reuse this layer.
RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m venv /opt/verseviva/demucs \
    && /opt/verseviva/demucs/bin/pip install \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.1 \
    && /opt/verseviva/demucs/bin/pip install -r requirements-demucs.txt \
    && python -m venv /opt/verseviva/whisperx \
    && /opt/verseviva/whisperx/bin/pip install \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 \
    && /opt/verseviva/whisperx/bin/pip install \
      -c requirements-whisperx-cpu.txt -r requirements-whisperx.txt \
    && /opt/verseviva/whisperx/bin/python -c "import torch; assert torch.version.cuda is None"

COPY pyproject.toml ./
COPY server ./server
COPY scripts ./scripts
RUN python -m pip install .

COPY --from=web-builder /app/web/dist /app/web/dist
RUN mkdir -p /app/data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3)"

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
