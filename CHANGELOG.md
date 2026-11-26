# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The `actual` skill tells your agent that a decision only the web app can restore, such as one deferred before it was archived, makes `actual adr restore` exit 3, and to send you to the Archived list in the web app. Needs the first Actual CLI release after 0.17.0. See [The actual skill](https://docs.actual.ai/plugin)
