---
title: Python and uv
summary: Python 3.12+ with uv, ruff, mypy --strict, pytest AAA and pydantic-settings
group: stack
scopes: [project]
defaults: []
---

## Python and uv

- Target Python 3.12+ and manage virtual environments, dependencies, and lockfiles with `uv` (`pyproject.toml` and `uv.lock`); run commands with `uv run <command>` and add packages via `uv add` or `uv add --dev` rather than `pip install`.
- Write complete type annotations on all functions, methods, and public attributes, and enforce static typechecking with `uv run mypy --strict`.
- Validate environment configuration at startup using `pydantic-settings` (`BaseSettings`) and validate external data boundaries with Pydantic v2 (`BaseModel`, `ConfigDict`).
- Lint and format with `uv run ruff check` and `uv run ruff format`, and write unit and integration tests with `uv run pytest` structured in arrange, act, and assert phases separated by blank lines.
