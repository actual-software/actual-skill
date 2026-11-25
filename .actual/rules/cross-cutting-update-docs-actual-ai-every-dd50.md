---
version: 2
name: cross-cutting-update-docs-actual-ai-every-dd50
description: Update docs.actual.ai with every user-facing plugin change
metadata:
  actual:
    adr_id: dd50a7e0-9a6a-4e55-abdf-8dd77dfba656
    status: accepted
  scope:
    root: .
    paths:
      - skills/**
      - hooks/**
      - "!hooks/tests/**"
      - "!hooks/**/*.test.ts"
      - commands/**
      - .claude-plugin/**
      - .codex-plugin/**
      - CHANGELOG.md
---

# Update docs.actual.ai with every user-facing plugin change

Scope: applies to `skills/**`, `hooks/**`, `commands/**`, `.claude-plugin/**`, `.codex-plugin/**`, `CHANGELOG.md`; excludes `!hooks/tests/**`, `!hooks/**/*.test.ts`.

### Rules

- **R-DD50-001** MUST: A change to a skill's trigger text or commands, a hook's behavior, the slash command, a setting or the manifests opens a pull request in the docs.actual.ai repository that updates the reference page covering it, and merges it once this change has merged, unless the change needs an Actual CLI version that no published release reaches yet. The diff shows this as a CHANGELOG line that links that page.
- **R-DD50-002** MUST: A change that needs a newer Actual CLI names that minimum version in its docs pull request, which carries the awaits-cli-release label while no published Actual CLI release reaches it. The diff shows this as the same version named in the change's CHANGELOG line.
