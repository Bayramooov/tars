# tars — working agreement

Node.js 24 + TypeScript (strict, ESM), no build step: Node runs `src/*.ts`
directly (type stripping), `tsc` only typechecks.

## Commands

- `npm run check` — typecheck + lint + tests. Run before calling anything done.
- `npm test` / `npx vitest run test/<area>` — unit and integration tests (fakes only: no network, no real Claude).
- `npm start` — run the bot (needs `.env`); `npm run trace -- --follow` — Claude Code I/O viewer.

## How to write code

- Keep it simple and readable. Avoid over-engineering; no speculative features, flags or abstractions.
- Before writing new code, look for code that already does it and reuse it.
- Prefer deleting and simplifying over adding code to patch old code.
- Fix the root cause of a bug. No workarounds, no wrappers around the symptom.
- No defensive `try/catch` or null checks that silence errors — fix why the error happens.
  Catch only operational failures (Telegram/network/DB hiccups) and log them.
- Don't keep old code "just in case". No dead code, no re-exports, no shims.
- One composition root (`src/app.ts`): dependencies are passed explicitly; no module-level mutable state.
- Long-lived components expose `start()` / `stop()`. Every promise is awaited or explicitly caught.
- Cancellation via `AbortController`/`AbortSignal`; clear every timer.
- Config is parsed once (`src/config.ts`); nothing else reads `process.env`.

## Limits (enforced by `eslint.config.js`)

- Files < 300 lines (tests < 1000), functions < 40 lines, ≤ 4 parameters (use an options object),
  nesting ≤ 4, cyclomatic complexity < 10.
- Only `src/claude/child.ts` may import `node:child_process`; tools never import `node:fs`
  (they go through `src/stores/`); only `src/browser/` imports `playwright`.

## TypeScript

- Erasable syntax only: no enums, namespaces or parameter properties; `import type` for types;
  relative imports end in `.ts`.
- Use `undefined` internally, `null` only at DB/JSON boundaries.
- Telegram limits are UTF-16 units (`.length`); byte caps use `Buffer.byteLength`;
  never cut inside a surrogate pair.
- When writing escapes for invisible characters, use `\u{200B}` form.

## Tests

- vitest, one test file per module, behavior-level (no private internals).
- Golden fixtures in `test/golden/` pin model-visible output and schemas; change them only on purpose.
- `test/fakes/fake-claude.ts` stands in for the `claude` CLI (scenarios via `#fake` directives); the fake Telegram intercepts every Bot API call.
- Never make the suite green by deleting, skipping or weakening a test.

## Docs

- README and docs are for humans: plain words, short sections, one example per idea.
- Comments explain why, not what. Keep them short.
