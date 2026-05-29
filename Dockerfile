FROM oven/bun:1.3-debian AS base
WORKDIR /app

# Install sharp native deps and lightweight media extraction tools.
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev ffmpeg curl ca-certificates python3 && apt-get clean

# Track latest release metadata so Docker cache invalidates when yt-dlp ships.
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /usr/local/share/yt-dlp-latest.json

# Install the latest yt-dlp release directly; distro packages are often stale.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && ffmpeg -version | head -n 1

# --- Install dependencies ---
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Dev dependencies (for type-checking in CI) ---
FROM base AS deps-dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- Production image ---
FROM base AS prod
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/
COPY prompts/ ./prompts/

# Embedding model cache and data directories created at runtime via volumes
RUN mkdir -p /app/data /app/model-cache

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
