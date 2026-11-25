# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.14.0] - 2026-11-25

### Added
- Codex sessions report their end the way Claude Code sessions do. The plugin registers Codex's `SessionEnd` hook (Codex 0.166 or later), so a Codex session sends `actual.session.ended`, always with the reason `other`. Signed in, the event also carries the session's token totals per model, read from its rollout, which needs an Actual CLI newer than 0.17.0. See [Hooks](https://docs.actual.ai/plugin/hooks)
