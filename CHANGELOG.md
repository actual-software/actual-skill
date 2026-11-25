# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The first session of the day in a repository with rules tells you when a newer `actual` CLI is out, with the upgrade command for however you installed it, in Claude Code and in Codex (needs `actual` 0.9.0 or later). To turn it off, set `ACTUAL_NO_UPDATE_CHECK=1` or run `actual config set update_check.enabled false`. See [Hooks](https://docs.actual.ai/plugin/hooks)
