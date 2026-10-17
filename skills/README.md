# skills/

Playbooks the bot reads at runtime: one directory each, with a `SKILL.md` ([Agent Skills spec](https://agentskills.io/specification)) and sometimes a `README.md` for people.

| Skill | Mode | What it does |
|---|---|---|
| [self-reflection](self-reflection/) | invoked | The daily learning loop: review the last 24 hours of the bot's own replies, stress-test pending lessons, propose new rules to the owner. Fired by a seeded reminder; refused outside a real `<reminder>` envelope. |
| [render-style](render-style/) | reference | House style for `render_html`: tokens, layout rules and three copy-paste skeletons (dashboard, timeline, architecture diagram). |
| [reminder-format](reminder-format/) | reference | How to word `reminder_set` text so a fired reminder explains itself. |

An *invoked* skill runs only when a reminder's text is `<skill name="…">run</skill>`; a *reference* skill is read on the bot's own initiative. The mode comes from what `SKILL.md` says, not from a flag.

The bot can create or update a skill with `skill_write` once the owner approves — the self-reflection loop proposes some that way. To add one by hand, see [docs/tools.md](../docs/tools.md#skills).
