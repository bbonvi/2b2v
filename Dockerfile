# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3-debian AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Build against the runtime's Python ABI, then download the converted multilingual model.
FROM base AS faster-whisper-builder
ARG FASTER_WHISPER_VERSION=1.2.1
ARG FASTER_WHISPER_MODEL_REVISION=536b0662742c02347bc0e980a01041f333bce120
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/faster-whisper \
    && /opt/faster-whisper/bin/pip install --no-cache-dir "faster-whisper==${FASTER_WHISPER_VERSION}" \
    && /opt/faster-whisper/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', revision='${FASTER_WHISPER_MODEL_REVISION}', local_dir='/opt/faster-whisper/models/small')"

FROM base AS voice-base
COPY --link --from=faster-whisper-builder /opt/faster-whisper /opt/faster-whisper
COPY --chmod=755 scripts/faster_whisper_server.py /usr/local/bin/faster-whisper-server

# Install standalone yt-dlp without pulling Python into the runtime image.
FROM scratch AS yt-dlp
ARG YT_DLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
ADD --chmod=755 ${YT_DLP_URL} /yt-dlp

# --- Install dependencies ---
FROM voice-base AS deps
COPY --link package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer

# --- Dev dependencies (for type-checking in CI) ---
FROM voice-base AS deps-dev
COPY --link package.json bun.lock ./
RUN bun install --frozen-lockfile

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
