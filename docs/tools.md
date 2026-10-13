# Tools

Where each supported tool reads its instructions and skills, and what the CLI writes for it.

| Tool                    | System-wide instructions                                       | System-wide skills                           | Project files                                                   | Notes                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antigravity (IDE)       | `~/.gemini/AGENTS.md`                                          | Links in `~/.gemini/config/skills/<name>`    | `AGENTS.md`, `.agents/skills/<name>`                            | Also reads `~/.gemini/GEMINI.md` and `~/.gemini/config/{AGENTS,GEMINI}.md`; `doctor` warns when those exist. Rule files are truncated above 24,000 bytes.                                    |
| Antigravity CLI (`agy`) | `~/.gemini/AGENTS.md`                                          | Links in `~/.gemini/antigravity-cli/skills/` | `AGENTS.md`, `.agents/skills/<name>`                            | Shares `~/.gemini/AGENTS.md` with the IDE                                                                                                                                                    |
| Gemini CLI              | `~/.gemini/AGENTS.md`                                          | `~/.agents/skills/<name>`                    | `AGENTS.md`, `.gemini/settings.json`, `.agents/skills/<name>`   | Reads `AGENTS.md` once `context.fileName` includes it, so the CLI adds `["AGENTS.md", "GEMINI.md"]` to the settings. `~/.gemini/GEMINI.md` is then loaded too; `doctor` warns when it exists |
| Claude Code             | `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude`)           | Links in `$CLAUDE_CONFIG_DIR/skills/<name>`  | `CLAUDE.md` with `@AGENTS.md`, links in `.claude/skills/<name>` | Claude Code recommends keeping memory files under 200 lines; `doctor` notes when the file is longer                                                                                          |
| Codex                   | `$CODEX_HOME/AGENTS.md` (default `~/.codex`)                   | `~/.agents/skills/<name>`                    | `AGENTS.md`, `.agents/skills/<name>`                            | An `AGENTS.override.md` next to it wins; `doctor` warns when one exists                                                                                                                      |
| Copilot                 | `$COPILOT_HOME/copilot-instructions.md` (default `~/.copilot`) | `~/.agents/skills/<name>`                    | `AGENTS.md`, `.agents/skills/<name>`                            | Read by Copilot CLI and the VS Code Copilot agent                                                                                                                                            |

Antigravity, `agy` and Gemini CLI share `~/.gemini/AGENTS.md`, so each of them loads the instructions once. System-wide skills are stored once in `~/.agents/skills/<name>`, which Codex, Gemini CLI and Copilot read directly, and linked per skill into `~/.claude/skills/<name>`, `~/.gemini/config/skills/<name>` and `~/.gemini/antigravity-cli/skills/<name>` for the tools that read their own directories. When one of those directories is itself a link to `~/.agents/skills` (or `.claude/skills` links to `.agents/skills` in a project), the tool already reads the shared copies, so the CLI creates no per-skill links there.

Gemini CLI also reads `~/.gemini/skills/` and Copilot also reads `$COPILOT_HOME/skills/` (default `~/.copilot/skills`). The CLI never writes to or adopts from those directories; `doctor` scans them, along with the directories above and Antigravity plugin skills, to report skills declared more than once under the same name.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` and `XDG_CACHE_HOME` must be absolute paths when set. `GEMINI_CLI_HOME` is not supported: the shared file always lives in `~/.gemini`, because Antigravity reads it from there.

## Sources

- [AGENTS.md](https://agents.md)
- [Agent Skills specification](https://agentskills.io/specification)
- [Antigravity rules](https://antigravity.google/docs/rules)
- [Gemini CLI context files](https://geminicli.com/docs/cli/gemini-md)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Copilot customization](https://docs.github.com/en/copilot/reference/customization-cheat-sheet)
- [Gemini CLI agent skills](https://geminicli.com/docs/cli/skills)
- [Copilot agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
