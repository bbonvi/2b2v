# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3-debian AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install standalone yt-dlp without pulling Python into the runtime image.
FROM scratch AS yt-dlp
ARG YT_DLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
ADD --chmod=755 ${YT_DLP_URL} /yt-dlp

# --- Install dependencies ---
FROM base AS deps
COPY --link package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer

# --- Dev dependencies (for type-checking in CI) ---
FROM base AS deps-dev
COPY --link package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- Production image ---
FROM base AS prod
COPY --link --from=yt-dlp /yt-dlp /usr/local/bin/yt-dlp
COPY --link --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/

# Embedding model cache and data directories created at runtime via volumes
RUN mkdir -p /app/data /app/model-cache

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
