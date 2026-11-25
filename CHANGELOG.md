# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- A session start that offers a Homebrew user an `actual` CLI upgrade can now pass on `brew update && brew upgrade actual-software/actual/actual`, the command `actual version --json` names from actual 0.18.0, rather than both package managers' commands. Older CLIs' `brew upgrade actual-software/actual/actual` is still passed on. Nothing you see changes yet: today the offer only reaches CLIs older than 0.8.0, which never name the new command. It shows once the offer also covers a newer CLI release. See [Hooks](https://docs.actual.ai/plugin/hooks)
