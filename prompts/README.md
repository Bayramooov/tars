# prompts/

The system prompt, composed from these files each time `claude` starts.

| File | Purpose | Tracked? |
|---|---|---|
| `system.md` | Generic tars behaviour — identity, tool discipline, formatting, security, memory rules. Ships with the repo. | yes |
| `project.md` | Your overlay — bot name, persona, language, owner-specific rules. Loaded if present, appended after `system.md`. | gitignored |
| `project.md.example` | Template you copy to `project.md` on first setup. | yes |
| `subagents.md` | Docs for the `Agent` tool. Appended only when `tool_groups.subagents` is `true` in `plugins.json`. | yes |

Edit the markdown; restart the bot (`docker compose up -d
--force-recreate` or rerun `npm start`) to reload. The bot
can append to `project.md` itself via `instruction_append` — every
write is backed up to `data/prompt_backups/` first.
