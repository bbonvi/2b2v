The bot is designed to impersonate yorha 2b.

## Bot runtime instructions

`profiles/` is the single source of truth for profile configs and instructions. `.env` selects the development profile and `.env.prod` selects the production profile; never modify the production environment without explicit instruction.

## Harness

We should enforce compatability with openrouter, but openai-codex is our main provider and we use it pretty much always.

## Project Documentation

- `README.md` — what the bot does, requirements, quick start, usage, configuration reference

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
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

Always use `make test` instead of `bun test`. Supports direct paths just like `bun test`:

```sh
make test                                    # all tests
make test src/agent/                         # directory
make test src/agent/read-images-tool.test.ts # specific file
make test-unit                               # optional: skips integration tests (not required after make test)
```

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

Then, run index.ts:

```sh
bun ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Quality checks

After making code changes, run these checks before committing:

```sh
make check        # tsc --noEmit && eslint src/
make test         # runs all tests
```

`make test-unit` is optional and intended for faster targeted loops without integration tests. Do not run it redundantly after a green `make test` unless you need that explicit signal.

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

## Docker Compose

- After all development changes, rebuild and restart the bot: `docker compose -f docker-compose.dev.yml -p 2b2v up -d --build bot`
- Production runs only on `hetzner-fi1-vpn`; never start the production Compose stack locally.
- Deploy current branch to Hetzner production: `.dev/remote-prod.sh deploy [branch]`
- Sync local profiles, including configs, instructions, and guild configs, to Hetzner production: `.dev/remote-prod.sh sync-profiles`
- Build, sync config, then restart Hetzner production: `.dev/remote-prod.sh all [branch]`

## File Scope

- Keep `.codex/AGENTS.md` stable and minimal; do not add feature-specific behavior notes here.
- Put transient gotchas and debugging learnings in `.dev/notes.md`.
- Update this file only for durable repo-wide process changes or when explicitly requested.

# Git
Do not use conventional commits. Follow established commit style.

# Extra Notes
- This project is actively developing, no need for backward compatability. Make breaking changes.
- When testing, filter out passing test lines; keep summaries and failures, e.g. pipe Bun output through an `awk` summary filter instead of tailing thousands of `(pass)` lines.
- Keep stable persona/style policy in `profiles/<profile>/instructions/core/` and runtime policy in scoped `profiles/shared/instructions/runtime/` or profile override files. Only small, atomic, single-sentence guardrails may stay inline in code; larger tool descriptions, parameter descriptions, context snippets, and runtime behavior policy belong in instruction files.
- Instruction edits should reduce sprawl. Prefer consolidating, rewriting, moving, or deleting existing instruction policy before adding new rules. Add new instructions only when they cover genuinely new behavior or intentional stronger steering, and avoid duplicate or conflicting guidance.
- Do not write tests that assert verbatim instruction prose; test instruction loading, structure, ordering, roles, cache placement, template variables, and behavior instead.
- Remove outdated/dead instructions.
- Always be mindful of prompt caching: we should preserve as much context between requests as possible and make it maximally stable.
- Keep instructions concise and high-signal. Do not output a wall of text for what should be a simple paragraph or sentence.
- Do not narrate implementation details back into instruction text.
- Before creating instructions, inspect related instruction files for consolidation, replacement, or removal opportunities.
- When asked to change or review instructions, inspect the existing instruction set to avoid redundancy and conflicts.
- Scope instruction exploration to the specified profile. Inspect applicable shared instructions, but do not inspect other profiles unless the task explicitly requires cross-profile comparison or changes.
- Avoid redudant/verbose/duplicate instructions.
- When suggesting instruction edits, make the smallest necessary change in a concrete instruction file rather than adding broad policy across several files.
- Runtime instruction files should be scoped by purpose (`reply/`, `tools/`, `tool-parameters/`, `context/`, `memory/`, `image-reading/`) so maintainers can edit behavior without touching code.
- Large specialized behavior that is irrelevant to most turns should live in manifest-backed `profiles/<profile>/instructions/skills/<id>/` packs and be loaded through `load_skill`, not in always-loaded reply runtime.
- For the most part we want 2b to be able to send intermediate replies. So she can send a message, do something, send another message. New features should not break this behaviour.
