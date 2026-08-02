# syntax=docker/dockerfile:1.7

ARG DENO_VERSION=2.9.4
ARG UV_VERSION=0.12.1

FROM oven/bun:1.3-debian AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 poppler-utils python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Build against the runtime's Python ABI, then download the converted multilingual model.
FROM base AS faster-whisper-builder
ARG FASTER_WHISPER_VERSION=1.2.1
ARG FASTER_WHISPER_MODEL_REVISION=536b0662742c02347bc0e980a01041f333bce120
ARG SILERO_VAD_REVISION=be95df9152c0d7618fa1edfeb296fc3dae32376f
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/faster-whisper \
    && /opt/faster-whisper/bin/pip install --no-cache-dir "faster-whisper==${FASTER_WHISPER_VERSION}" \
    && /opt/faster-whisper/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', revision='${FASTER_WHISPER_MODEL_REVISION}', local_dir='/opt/faster-whisper/models/small')" \
    && mkdir -p /opt/faster-whisper/models/silero-vad
ADD --checksum=sha256:1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3 \
    https://raw.githubusercontent.com/snakers4/silero-vad/${SILERO_VAD_REVISION}/src/silero_vad/data/silero_vad.onnx \
    /opt/faster-whisper/models/silero-vad/silero_vad.onnx

FROM base AS voice-base
COPY --link --from=faster-whisper-builder /opt/faster-whisper /opt/faster-whisper
COPY --chmod=755 scripts/faster_whisper_server.py /usr/local/bin/faster-whisper-server
COPY --chmod=755 scripts/silero_vad_server.py /usr/local/bin/silero-vad-server

# @discordjs/opus falls back to a source build when a matching libc prebuild is
# unavailable, while the compiled addon itself does not need this toolchain.
FROM voice-base AS dependency-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install standalone yt-dlp without pulling Python into the runtime image.
FROM scratch AS yt-dlp
ARG YT_DLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
ADD --chmod=755 ${YT_DLP_URL} /yt-dlp

FROM scratch AS yt-dlp-nightly
ARG YT_DLP_NIGHTLY_URL=https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp
ADD --chmod=755 ${YT_DLP_NIGHTLY_URL} /yt-dlp

FROM denoland/deno:bin-${DENO_VERSION} AS workspace-deno
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS workspace-uv
FROM node:24-bookworm-slim AS workspace-node

# --- Install dependencies ---
FROM dependency-builder AS deps
COPY --link package.json bun.lock ./
COPY --link patches/ ./patches/
RUN bun install --frozen-lockfile --production --omit=peer

# --- Dev dependencies (for type-checking and linting in CI) ---
FROM dependency-builder AS deps-dev
COPY --link package.json bun.lock ./
COPY --link patches/ ./patches/
RUN bun install --frozen-lockfile

# --- Disposable root workspace controlled only through its Unix socket ---
FROM base AS workspace
ARG PLAYWRIGHT_CLI_VERSION=0.1.17
COPY --link --from=yt-dlp-nightly /yt-dlp /usr/local/bin/yt-dlp
COPY --link --from=workspace-deno /deno /usr/local/bin/deno
COPY --link --from=workspace-uv /uv /uvx /usr/local/bin/
COPY --link --from=workspace-node /usr/local/bin/node /usr/local/bin/node
COPY --link --from=workspace-node /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV PATH="/opt/workspace-python/bin:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl jq file zip unzip 7zip xz-utils zstd sqlite3 \
        imagemagick libimage-exiftool-perl qpdf \
        tesseract-ocr tesseract-ocr-eng \
        fonts-noto-core fonts-noto-color-emoji \
        build-essential pkg-config \
        procps lsof iproute2 dnsutils rsync shellcheck \
    && rm -rf /var/lib/apt/lists/*
RUN uv venv --python /usr/bin/python3 /opt/workspace-python \
    && uv pip install --python /opt/workspace-python/bin/python --no-cache \
        Pillow numpy pandas matplotlib requests \
        beautifulsoup4 lxml PyYAML \
        pypdf openpyxl python-docx python-pptx reportlab
RUN npm install --global "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
    && PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 playwright-cli install-browser chromium --with-deps \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
RUN printf '%s\n' 'export PATH="/opt/workspace-python/bin:$PATH"' > /etc/profile.d/workspace-python.sh
COPY src/workspace/ ./src/workspace/
RUN mkdir -p /workspace /workspace/staged-assets /run/2b2v
WORKDIR /workspace
CMD ["bun", "run", "/app/src/workspace/server.ts"]

# --- Production image ---
FROM voice-base AS prod
COPY --link --from=yt-dlp /yt-dlp /usr/local/bin/yt-dlp
COPY --link --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/

# Persistent application data is mounted here at runtime.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
