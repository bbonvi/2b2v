# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3-debian AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Build a pinned native CPU whisper.cpp and keep its persistent server plus multilingual model.
FROM debian:bookworm-slim AS whisper-builder
ARG WHISPER_CPP_VERSION=v1.9.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake curl git g++ make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp.git . \
    && cmake -S . -B build \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=ON \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build --config Release --target whisper-cli whisper-server -j"$(nproc)" \
    && ./models/download-ggml-model.sh small

FROM base AS voice-base
COPY --link --from=whisper-builder /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --link --from=whisper-builder /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --link --from=whisper-builder /src/models/ggml-small.bin /opt/whisper/models/ggml-small.bin

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
