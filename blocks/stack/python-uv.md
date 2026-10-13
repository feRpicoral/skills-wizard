---
title: Python and uv
summary: uv dependency management, strict type annotations, Pydantic v2 and Ruff
group: stack
scopes: [project]
defaults: []
---

## Python and uv

- Manage virtual environments, dependencies, and lockfiles with `uv` (`pyproject.toml` and `uv.lock`); execute commands via `uv run <command>` and add packages with `uv add` or `uv add --dev` rather than `pip install`.
- Write complete type annotations on all functions, methods, and public attributes, and validate external payloads and configuration boundaries with Pydantic v2 (`BaseModel`, `ConfigDict`).
- Lint and format with `uv run ruff check` and `uv run ruff format`, typecheck with `uv run pyright` or `uv run mypy`, and run tests with `uv run pytest`.
