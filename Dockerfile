FROM oven/bun:1.3-debian AS base
WORKDIR /app

# Install sharp native deps
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev && rm -rf /var/lib/apt/lists/*

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
