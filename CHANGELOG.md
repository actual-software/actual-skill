# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The plan and implementation gates rank the candidate rules before they judge. With Actual CLI 0.18.0 or later, `plan-check` and `impl-check` run from the gates ask your configured model to score the rules their first pass found, whenever it found more than the check judges, and the judge then reads only the rules that scored as applying: over 25 merged pull requests, a larger share of the rules judged were ones that govern the change. The rank keeps to 15 seconds and falls back to the first pass when it misses, and the gates' hook timeout is now 200 seconds (was 180) to make room for it. Set `ACTUAL_GATE_RANK=off` to skip the rank and keep the judge as each check's only model call. See [Settings](https://docs.actual.ai/plugin/settings) and [Hooks](https://docs.actual.ai/plugin/hooks)
