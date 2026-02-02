## Project Documentation

- `README.md` — what the bot does, requirements, quick start, usage, configuration reference
- `ARCHITECTURE.md` — module map, core dataflows, database schema, Qdrant setup, config system, key patterns, Docker, dependencies, testing

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Quality checks

After making code changes, always run all three checks before committing:

```sh
make check        # tsc --noEmit && eslint src/
make test         # starts Qdrant container if needed, runs all tests
make test-unit    # non-Qdrant tests only (no container needed)
```

- `bun run lint` — runs ESLint with strict type-aware rules (no `any`, no floating promises, strict boolean expressions, etc.)
- `bun run lint:fix` — auto-fix what ESLint can fix
- `bun run check` — type-check + lint in one command
- `tsc --noEmit` — type-check only

Rules enforced by ESLint (eslint.config.ts):
- No `as any` — use proper types or `unknown` with type guards
- No `!` non-null assertions — use explicit null checks
- No floating promises — always `await` or `void` fire-and-forget calls
- No implicit boolean coercion — use explicit `!== undefined`, `!== null`, `!== ""`
- No enums — use `as const` objects
- `===` always — no loose equality
- `import type` for type-only imports
- Unused vars must be prefixed with `_`

## Qdrant (vector search)

Tests in `src/qdrant/`, `src/embeddings/queue.test.ts`, `src/db/message-repository.test.ts`, and `src/agent/search-tool.test.ts` require a running Qdrant instance.

`make test` handles this automatically — starts a `qdrant-test` container if needed and overrides `QDRANT_URL`. Manual control:
```sh
make qdrant-up    # start container
make qdrant-down  # stop and remove
```

Docker-compose Qdrant (`http://qdrant:6333`) is internal-only — no exposed ports. Host tests use `http://qdrant-test.orb.local:6333` (OrbStack DNS).

## Key utilities and patterns (keep updated as new modules are added)

- `isAdmin(PermissionContext)` — `src/commands/permissions.ts`. Checks Discord `Administrator` bitflag, falls back to per-guild `adminUserIds`.
- `registerSlashCommands({ token, clientId, commands })` — `src/commands/registry.ts`. Global REST registration via discord.js.
- `createStatusHandler(deps)`, `createMemoryWipeHandler(deps)`, `createScheduleHandler(deps)` — `src/commands/`. Factory pattern: inject deps, return `(ChatInputCommandInteraction) => Promise<void>`. All responses ephemeral.
- `loadGlobalConfig(env)`, `loadGuildConfigs(dir, global)`, `resolveGuildConfig(global, partial)`, `saveGuildConfig(path, config)` — `src/config/loader.ts`.
- `translateInbound(text, resolvers)`, `translateOutbound(text, resolvers)` — `src/discord/translation.ts`. Pure functions with injected resolvers.
- `splitMessage(text, limit?)` — `src/discord/split-message.ts`. Splits text into ≤2000-char chunks (newlines → sentences → hard cut). Used after `translateOutbound` in sender and scheduler.
- `shouldRespond(input, config, rng?)` — `src/agent/triggers.ts`. Trigger evaluation with priority: mention > keyword > random.
- `handleMessage(msg, deps)` — `src/agent/handler.ts`. Orchestrates trigger → prompt → agent → response.
- `createSendMessageTool(sender)` — `src/agent/send-message-tool.ts`. Agent tool: send a single message (reply or normal).
- `trimChatHistory(messages, config)` — `src/agent/context-trimming.ts`. Chunked trim by message count. Note: chat history now reads directly from SQLite (no in-memory buffer); trimming is handled via SQL `LIMIT`.
- `assembleSystemPrompt(ctx)` — `src/agent/prompt.ts`. Composes persona/emojis/members/journal/schedules/history.
- `createDatabase(path)` — `src/db/database.ts`. SQLite with WAL mode; memories/messages/schedules tables.
- `createMemory/updateMemory/deleteMemory/listMemories/deleteExpiredMemories` — `src/db/memory-repository.ts`.
- `createSchedule/updateSchedule/deleteSchedule/listSchedules` — `src/db/schedule-repository.ts`.
- `searchMessages(db, qdrant, vec, filter)` — `src/db/message-repository.ts`. Semantic search: Qdrant KNN → SQLite JOIN.
- `searchMessagesLiteral(db, query, filter)` — `src/db/message-repository.ts`. Case-insensitive keyword/phrase search via SQLite LIKE. No Qdrant.
- `getMessageById(db, messageId, guildId)` — `src/db/message-repository.ts`. Direct message lookup by ID within guild. Pure SQLite, no Qdrant.
- `createQdrantClient/ensureCollection/healthCheck` — `src/qdrant/client.ts`.
- `upsertPoint/upsertPoints/deletePoint/searchPoints/toPointId` — `src/qdrant/adapter.ts`.
- `createEmbeddingPipeline/getEmbeddingPipeline` — `src/embeddings/pipeline.ts`. bge-m3 via @huggingface/transformers.
- `createEmbeddingQueue(pipeline, qdrant, opts)` — `src/embeddings/queue.ts`. Batched async queue.
- `createSchedulerEngine({ db, onFire })` — `src/scheduler/engine.ts`. Croner for cron, setTimeout for one-offs.
- Agent tools follow factory pattern: `createXTool(deps)` with guild auto-injected via closure. Located in `src/agent/`.

# Notes
DO NOT use conventional commits skill and conventional commits themselves. Follow established commit style.
