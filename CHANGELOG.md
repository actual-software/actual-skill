# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.14.0] - 2026-11-27

### Added
- Before anything else, every hook except the session-end one brings `.actual/rules/` in step with your decisions, the accepted ADRs in `docs/adr/` signed out and your decisions in Actual AI signed in, so a newly published decision reaches the checks and briefing within minutes. On tool calls it runs at most once every five minutes per repository. `ACTUAL_ADR_REFRESH=off` turns it off and `ACTUAL_ADR_REFRESH_EVERY` sets the interval in seconds. Needs Actual CLI 0.17.0; signed in, a repository whose decisions Actual AI can't read within a second keeps its rule files until the CLI release that reads only what changed. See [Hooks](https://docs.actual.ai/plugin/hooks#the-rule-file-refresh)
