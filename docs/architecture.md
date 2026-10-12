# Architecture

## Flow

Every command that writes builds a plan first. Interactive runs show the plan and ask before applying. `--dry-run` prints it and exits.

```mermaid
sequenceDiagram
    participant U as User
    participant C as CLI
    participant P as Planner
    participant F as Filesystem
    participant M as Manifest
    U->>C: init, sync
    C->>M: Read the previous manifest
    C->>P: Selection (tools, blocks, variables)
    P->>F: Read current files (lstat for links)
    P-->>C: Actions with status and next content
    C->>U: Show plan
    U->>C: Confirm
    C->>F: Apply each action
    C->>M: Record what was applied
```

## Blocks

`blocks/index.yaml` lists every block in composition order, together with the group labels and the header for the system-wide file. The loader rejects:

- files missing from the order
- unknown groups, or a group that does not match the block's directory
- defaults outside a block's scopes
- placeholders that are not declared as variables, and declared variables that are never used

The system-wide file is the global header plus the selected blocks joined by blank lines. A project file gets the selected blocks inside a managed region, below a `# <project name>` heading that is written once.

## Plans and actions

Each target becomes one action:

| Status      | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `create`    | The file or link does not exist yet                        |
| `update`    | The managed content differs from what is on disk           |
| `unchanged` | Nothing to do                                              |
| `remove`    | The entry is in the manifest but no longer selected        |
| `conflict`  | The file cannot be changed safely, so it is left untouched |

Conflicts come from malformed markers, JSON files with comments or invalid syntax, and unmanaged files at a path the CLI wants to own (for example `~/.local/bin/agents-config`).

## Writers

- **Managed region.** Text between `<!-- BEGIN:agents-config -->` and `<!-- END:agents-config -->`. A file without markers gets the region appended after its content. Duplicate or unmatched markers are a conflict.
- **Import line.** A single line such as `@AGENTS.md`, prepended to an existing `CLAUDE.md`.
- **JSON array values.** Adds values to a key such as `context.fileName` and removes only the values the CLI added. Files with comments are refused.
- **Exclude region.** `# BEGIN:agents-config` markers in `.git/info/exclude`, for project files kept out of git.
- **Symlink.** Replaced only when the manifest owns it. A link someone retargeted is left alone.

Writes are atomic: content goes to a temporary file, which is then renamed over the target.

## Manifests

| Scope       | File                                    | Paths                            |
| ----------- | --------------------------------------- | -------------------------------- |
| System-wide | `~/.agents/agents-config/manifest.json` | Absolute                         |
| Project     | `<project>/.agents/agents-config.json`  | Relative, so it can be committed |

A manifest stores the selection (tools, blocks, variables, options) and one entry per owned path. After an apply, the manifest records every action that actually ran, so an interrupted run never loses track of files it already wrote. `~/.agents/agents-config/projects.json` lists the projects set up from this machine.

## Ownership rules

- Only paths recorded in a manifest are ever modified or deleted.
- A file the CLI created is deleted when its managed content is removed and nothing else is left. A file that existed before keeps its other content.
- A file shared by several tools, such as `~/.gemini/AGENTS.md`, stays until no selected tool uses it.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Success                                                                 |
| 1    | Conflicts were skipped, `doctor` found errors, or the run was cancelled |
| 2    | Usage error                                                             |
