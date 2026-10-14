# Tools

Where each supported tool reads its instructions, and what the CLI writes for it.

| Tool                    | System-wide file                                               | Project files                        | Notes                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antigravity (IDE)       | `~/.gemini/AGENTS.md`                                          | `AGENTS.md`                          | Also reads `~/.gemini/GEMINI.md` and `~/.gemini/config/{AGENTS,GEMINI}.md`; `doctor` warns when those exist. Rule files are truncated above 24,000 bytes.                                    |
| Antigravity CLI (`agy`) | `~/.gemini/AGENTS.md`                                          | `AGENTS.md`                          | Same file as the IDE                                                                                                                                                                         |
| Gemini CLI              | `~/.gemini/AGENTS.md`                                          | `AGENTS.md`, `.gemini/settings.json` | Reads `AGENTS.md` once `context.fileName` includes it, so the CLI adds `["AGENTS.md", "GEMINI.md"]` to the settings. `~/.gemini/GEMINI.md` is then loaded too; `doctor` warns when it exists |
| Claude Code             | `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude`)           | `CLAUDE.md` with `@AGENTS.md`        | Claude Code recommends keeping memory files under 200 lines; `doctor` notes when the file is longer                                                                                          |
| Codex                   | `$CODEX_HOME/AGENTS.md` (default `~/.codex`)                   | `AGENTS.md`                          | An `AGENTS.override.md` next to it wins; `doctor` warns when one exists                                                                                                                      |
| Copilot                 | `$COPILOT_HOME/copilot-instructions.md` (default `~/.copilot`) | `AGENTS.md`                          | Read by Copilot CLI and the VS Code Copilot agent                                                                                                                                            |

Antigravity, `agy` and Gemini CLI share `~/.gemini/AGENTS.md`, so each of them loads the instructions once.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` must be absolute paths when set. `GEMINI_CLI_HOME` is not supported: the shared file always lives in `~/.gemini`, because Antigravity reads it from there.

## Sources

- [AGENTS.md](https://agents.md)
- [Antigravity rules](https://antigravity.google/docs/rules)
- [Gemini CLI context files](https://geminicli.com/docs/cli/gemini-md)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Copilot customization](https://docs.github.com/en/copilot/reference/customization-cheat-sheet)
