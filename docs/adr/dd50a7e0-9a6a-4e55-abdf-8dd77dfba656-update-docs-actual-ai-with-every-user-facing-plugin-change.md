---
version: 2
name: dd50a7e0-9a6a-4e55-abdf-8dd77dfba656-update-docs-actual-ai-with-every-user-facing-plugin-change
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

Status: accepted
Date: 2026-11-24
Deciders: actual-skill maintainers

## Context

- docs.actual.ai is the documentation home for the Actual.AI Plugin. Every page on it is written in the docs.actual.ai repository, which builds the site, so a plugin change that users see takes a second pull request there.
- The plugin installs from this repository's main branch, so a change reaches users when it merges, and a reference page updated later is wrong for everyone who installs in between.
- The site documents released features only. A docs pull request for a step that needs an Actual CLI newer than the latest release waits under the site's awaits-cli-release label, and the site's release job merges it once a published release reaches the version it names.
- The plugin's end-of-turn check judges the diff alone, so each rule asks for something the diff shows: a CHANGELOG line that links the page the change's docs pull request updates.

## Decision

1. MUST: A change to a skill's trigger text or commands, a hook's behavior, the slash command, a setting or the manifests opens a pull request in the docs.actual.ai repository that updates the reference page covering it, and merges it once this change has merged, unless the change needs an Actual CLI version that no published release reaches yet. The diff shows this as a CHANGELOG line that links that page.
2. MUST: A change that needs a newer Actual CLI names that minimum version in its docs pull request, which carries the awaits-cli-release label while no published Actual CLI release reaches it. The diff shows this as the same version named in the change's CHANGELOG line.

## Rationale

- A CHANGELOG line that links the page puts the docs change in the diff, where a reviewer and the end-of-turn check can both see it.
- Merging the docs pull request once the plugin's has merged keeps docs.actual.ai in step with main, which is what people install. Holding a page that needs an unreleased CLI keeps the site from describing a step no released CLI can run.

## Consequences

Positive:
- docs.actual.ai describes the plugin people install.
- CHANGELOG.md lists what changed in each version, with a link to each page.

Negative:
- Each user-facing change takes a second pull request, in another repository.
- A change that needs an unreleased CLI leaves its docs pull request open until a release reaches that version.

## References

- https://docs.actual.ai
- CHANGELOG.md
- CONTRIBUTING.md
