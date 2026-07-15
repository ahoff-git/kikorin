# packages/util — Logging

### Purpose
The project-wide debug logging contract required by CLAUDE.md: every TS layer routes debug output through `log()` so it can be silenced or filtered from one place. This is the only module `@kikorin/util` ships.

### Key Logic
- `log(level, message, keywords, ...data)` writes via `console.log/warn/error` chosen by level, with an ISO timestamp and a deep-copied `data` payload (so logged objects can't mutate after the call).
- **Off by default:** `currentLogLevel.value` starts at `logLevels.off`; set it to `logLevels.debug` at runtime to enable. Levels: `off < error < warning < debug`.
- `filterKeywords` (allow-list; empty = allow all) and `blockKeywords` (deny-list) gate messages by their `keywords` tags.

### Invariants
- Production builds stay silent unless a caller raises `currentLogLevel` explicitly.
- An invalid level is reported once via `console.error` and the message is dropped.

### Verification
`pnpm --filter @kikorin/util test` — level gating, keyword filter/block behavior, invalid-level handling, deep-copy semantics.
