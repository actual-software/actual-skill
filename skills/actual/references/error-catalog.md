# Error Catalog Reference

Complete catalog of all error types in the actual CLI. Load this when troubleshooting a specific error.

## Table of Contents

- [Error Summary Table](#error-summary-table)
- [Exit Code 2: Auth and Setup Errors](#exit-code-2-auth-and-setup-errors)
- [Exit Code 3: Billing and API Errors](#exit-code-3-billing-and-api-errors)
- [Exit Code 1: General Runtime Errors](#exit-code-1-general-runtime-errors)
- [Exit Code 4: User Cancelled](#exit-code-4-user-cancelled)
- [Exit Code 5: I/O Errors](#exit-code-5-io-errors)
- [Diagnosis Pattern](#diagnosis-pattern)

## Error Summary Table

| Error | Exit | Category | One-Line Fix |
|-------|------|----------|-------------|
| ClaudeNotFound | 2 | Auth/Setup | Install Claude Code CLI, ensure `claude` is in PATH |
| ClaudeNotAuthenticated | 2 | Auth/Setup | Run `claude auth login` |
| CodexNotFound | 2 | Auth/Setup | Install Codex CLI, ensure `codex` is in PATH |
| CodexNotAuthenticated | 2 | Auth/Setup | Set `OPENAI_API_KEY` or run `codex login` |
 | CursorNotFound | 2 | Auth/Setup | Install Cursor CLI, ensure `agent` is in PATH |
 | CursorNotAuthenticated | 2 | Auth/Setup | Set `CURSOR_API_KEY` or run `cursor-agent login` |
 | ApiKeyMissing | 2 | Auth/Setup | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| CodexCliModelRequiresApiKey | 2 | Auth/Setup | Set `OPENAI_API_KEY` (ChatGPT OAuth only supports default model) |
| NoRunnerAvailable | 2 | Auth/Setup | Install a runner or set an API key — none of the candidates for the given model were usable |
| NotLoggedIn | 2 | Auth/Setup | Run `actual login` (Actual AI platform sign-in; distinct from runner auth) |
| AdrAccessDenied | 2 | Auth/Setup | Run `actual login` again, or ask an admin for a role that can change decisions |
| AdrRepoRequired | 2 | Auth/Setup | Run it in a connected repository's checkout, or pass `--repo owner/name` |
| AdrPathway | 2 | Auth/Setup | Leave out the command or flag the pathway can't take, or sign in with `actual login` |
| CreditBalanceTooLow | 3 | Billing/API | Add credits to your account |
| ApiError | 3 | Billing/API | Check API URL, network, credentials |
| ApiResponseError | 3 | Billing/API | Check API status page, retry later |
| ServiceUnavailable | 3 | Billing/API | API is temporarily updating — retry automatically (10s, 30s, 60s), then fails gracefully |
| AdrCreateUnconfirmed | 3 | Billing/API | Look with `actual adr list` before running `create` again |
| AdrNotFound | 3 | Billing/API | Take the id from `actual adr list` |
| AdrNotAllowed | 3 | Billing/API | Do what the message names first, such as `actual adr restore <id>`, or leave the decision as it is |
| AdrNotSaved | 3 | Billing/API | Nothing was saved: check the network and `actual whoami`, then run it again |
| RunnerFailed | 1 | Runtime | Check runner output for details |
| RunnerOutputParse | 1 | Runtime | Check model compatibility with runner |
| RunnerTimeout | 1 | Runtime | Increase `invocation_timeout_secs` config |
| ConfigError | 1 | Runtime | Check YAML syntax, run `actual config show` |
| AnalysisEmpty | 1 | Runtime | Check project path and repo content |
| TailoringValidationError | 1 | Runtime | Retry, or use `--no-tailor` |
| InternalError | 1 | Runtime | Report as bug |
| TerminalIOError | 1 | Runtime | Check terminal capabilities |
| AdrInvalid | 1 | Runtime | Fix each reason the message lists, then run it again |
| AdrCheckFailed | 1 | Runtime | Fix each file the report names, then check again |
| AdrDuplicate | 1 | Runtime | Update the decision it names, or pass `--allow-duplicate` when the user wants both |
| IoError | 5 | I/O | Check file permissions and disk space |
| UserCancelled | 4 | User | Intentional cancellation (not an error) |

## Exit Code 2: Auth and Setup Errors

These errors mean the runner or authentication is not properly configured. Fix them before attempting sync.

### ClaudeNotFound

**Cause**: The `claude` binary is not found in PATH.

**Hint**: Install the Claude Code CLI or check that it is in your PATH.

**Diagnosis**:
```bash
which claude
echo $PATH
```

**Fix**: Install Claude Code CLI per its documentation. Ensure the install directory is in PATH.

### ClaudeNotAuthenticated

**Cause**: The Claude Code CLI is installed but not authenticated.

**Hint**: Run `claude auth login` to authenticate.

**Diagnosis**:
```bash
actual auth
claude auth status  # if available
```

**Fix**:
```bash
claude auth login
```

### CodexNotFound

**Cause**: The `codex` binary is not found in PATH.

**Hint**: Install the Codex CLI or check that it is in your PATH.

**Diagnosis**:
```bash
which codex
echo $PATH
```

**Fix**: Install Codex CLI per its documentation.

### CodexNotAuthenticated

**Cause**: The Codex CLI is installed but not authenticated.

**Hint**: Set `OPENAI_API_KEY` or run `codex login`.

**Diagnosis**:
```bash
codex --version  # verify binary works
echo $OPENAI_API_KEY | head -c 7  # check key prefix without revealing it
```

**Fix**:
```bash
# Option 1: API key
export OPENAI_API_KEY="sk-..."
# Option 2: ChatGPT OAuth
codex login
```

### CursorNotFound

**Cause**: The `agent` binary is not found in PATH.

**Hint**: Install the Cursor CLI or check that it is in your PATH.

**Diagnosis**:
```bash
which agent
```

**Fix**: Install Cursor CLI per its documentation.

### CursorNotAuthenticated

**Cause**: The Cursor CLI is installed but not authenticated.

**Hint**: Set `CURSOR_API_KEY` or run `cursor-agent login`.

**Diagnosis**:
```bash
agent --version  # verify binary works
echo $CURSOR_API_KEY | head -c 7  # check key prefix without revealing it
```

**Fix**:
```bash
# Option 1: API key
export CURSOR_API_KEY="..."
# Option 2: OAuth login
cursor-agent login
```

### ApiKeyMissing

**Cause**: The runner requires an API key that is not set, or the provided key was rejected by the API (HTTP 401/403).

**Hint**: The error message and hint both specify exactly which environment variable needs to be set (e.g., `Set ANTHROPIC_API_KEY environment variable or add it to your config file`).

**Diagnosis**:
```bash
# Check which keys are set (without revealing values):
[ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY: set" || echo "ANTHROPIC_API_KEY: not set"
[ -n "$OPENAI_API_KEY" ] && echo "OPENAI_API_KEY: set" || echo "OPENAI_API_KEY: not set"
```

**Fix**:
```bash
# For anthropic-api runner:
export ANTHROPIC_API_KEY="sk-ant-..."
# For openai-api runner:
export OPENAI_API_KEY="sk-..."
```

Or set in config (stored with 0600 permissions):
```bash
actual config set anthropic_api_key "sk-ant-..."
actual config set openai_api_key "sk-..."
```

### CodexCliModelRequiresApiKey

**Cause**: Using codex-cli with ChatGPT OAuth authentication and an explicit model. OAuth only supports the default model.

**Hint**: Set `OPENAI_API_KEY` to use explicit models with codex-cli.

**Diagnosis**:
```bash
actual config show  # check if model is set
echo $OPENAI_API_KEY | head -c 7  # check if key is set
```

**Fix**: Either remove the explicit model (use default) or set `OPENAI_API_KEY`:
```bash
# Option 1: Use default model
actual config set model ""
# Option 2: Set API key for explicit model support
export OPENAI_API_KEY="sk-..."
```

### NoRunnerAvailable

**Cause**: `actual adr-bot` was called without `--runner` or a `runner` config value, and none of the candidate runners for the given model passed their environment probe. The error message lists each candidate and the reason it was skipped.

**Hint**: Install a runner (e.g. `npm install -g @anthropic-ai/claude-code`) or set an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

**Diagnosis**:
```bash
# See exactly which runners were tried and why each failed:
actual adr-bot 2>&1          # stderr shows the "Tried:" list

# Check which binaries are installed:
which claude
which codex
which cursor-agent

# Check which API keys are set:
[ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC set" || echo "ANTHROPIC not set"
[ -n "$OPENAI_API_KEY" ]    && echo "OPENAI set"    || echo "OPENAI not set"
```

**Fix**: Install at least one runner for the model you are targeting, then re-run:
```bash
# For claude/sonnet models — install Claude Code CLI:
npm install -g @anthropic-ai/claude-code
claude auth login

# Or set the Anthropic API key directly:
export ANTHROPIC_API_KEY="sk-ant-..."

# For gpt/o-series models — set the OpenAI API key:
export OPENAI_API_KEY="sk-..."

# Alternatively, pin a specific runner with --runner to skip auto-detection:
actual adr-bot --runner anthropic-api
```

### NotLoggedIn

**Cause**: No valid Actual AI platform session — you have not run `actual login`, the stored credentials were cleared, or a token refresh failed. Raised by `actual whoami` and `actual advisor`. **Distinct from the runner-auth errors above** (`ClaudeNotAuthenticated` / `CodexNotAuthenticated` / `CursorNotAuthenticated`), which concern the coding-agent that `adr-bot` drives — not the platform.

**Display**: "Not signed in to Actual AI"

**Hint**: `actual login`

**Diagnosis**:
```bash
actual whoami   # no network; non-zero exit / "Not signed in" when logged out
```

**Fix**:
```bash
actual login                 # browser OAuth; hand off to a human in non-interactive shells
actual login --org <org-id>  # multi-org accounts: pre-select an org
```

A token that has merely expired is refreshed transparently by `advisor`; `NotLoggedIn` means there is no usable session at all. See `platform-advisor.md` for the full OAuth flow and the non-interactive playbook.

### AdrAccessDenied

**Cause**: Actual AI refused an `actual adr` request with HTTP 403: the sign-in lacks the decision scopes, it belongs to another organization, or the member's role can't change decisions.

**Display**: "Actual AI refused the request (HTTP 403): <reason>"

**Hint**: The remedy for the reason: `actual login` to sign in again with the decision scopes or for the organization the decisions belong to, or asking an admin for a role that can change decisions.

**Fix**: Hand `actual login` to the user, since it's interactive, or have them ask an admin of their organization for the role.

### AdrRepoRequired

**Cause**: A signed-in `actual adr create` needs a connected repository and couldn't tell which one from the checkout.

**Display**: "Couldn't tell which connected repository the decision belongs to: <reason>." (`create --all` says "the decisions belong to")

**Hint**: `Run it in a connected repository's checkout, or pass --repo owner/name`

**Fix**: Run the command in the checkout of a repository connected to Actual AI, or ask the user which repository to pass as `--repo owner/name`.

### AdrPathway

**Cause**: An `actual adr` command or flag the current pathway can't take. Signed out, the commands work on the files in `docs/adr/`, so the ones that need Actual AI are refused, such as `accept`, `unpublish`, `create --all` and `create --status draft`. Signed in, `create --deciders` is refused, since a decision in Actual AI has no Deciders line.

**Display**: Names the command or flag, why it needs the other pathway and what works instead, such as "`--status draft` saves a draft, and a draft lives in Actual AI, which needs `actual login`. Signed out, every decision `create` writes under docs/adr/ is accepted, so leave `--status` out."

**Fix**: Leave the command or flag out, or, when the user wants what only Actual AI does, hand `actual login` to them and run it after they sign in.

## Exit Code 3: Billing and API Errors

### CreditBalanceTooLow

**Cause**: The API account does not have sufficient credits for the requested operation.

**Hint**: Add credits at your provider's billing page or check your account quota.

**Diagnosis**: Check your account balance at the provider's dashboard (e.g., [Anthropic billing](https://console.anthropic.com/settings/billing) or [OpenAI billing](https://platform.openai.com/settings/organization/billing)).

**Fix**: Add credits. Consider using `--max-budget-usd` to control spending.

### ApiError

**Cause**: The API request failed (network error, invalid URL, authentication rejected by server).

**Hint**: Check your API URL, network connection, and credentials.

**Diagnosis**:
```bash
actual config show  # check api_url
curl -I <api_url>   # test connectivity
```

**Fix**: Verify `api_url` config, check network, ensure credentials are valid.

### ApiResponseError

**Cause**: The API returned an unexpected response (malformed JSON, unexpected status code).

**Hint**: This may be a transient issue. Try again later. If persistent, check the API status page.

**Diagnosis**: Run with `--verbose` and `--show-errors` for detailed error output.

**Fix**: Retry. If persistent, check the API provider's status page.

### ServiceUnavailable

**Cause**: The Actual AI API returned HTTP 503, indicating it is temporarily updating or unavailable.

**Behavior**: The CLI automatically retries 3 times with increasing delays (10s, 30s, 60s), showing live TUI messages during each wait ("Actual AI API is updating — retrying in Xs (N/3)..."). If all retries fail, the error is surfaced as a graceful message.

**Display**: "Actual AI API is being updated and will be available shortly"

**Fix**: Wait a few minutes and re-run. This is a transient condition during API deployments.

### Advisor & Platform API Errors

The `login` and `advisor` commands surface the generic `ApiError` / `ApiResponseError` (exit 3) above, but with platform-specific causes worth calling out:

- **`HTTP 404` from `advisor` ("failed to parse error response")** — the command is pointed at the wrong base URL (e.g. the built-in prod default instead of your intended local/staging endpoint), so the path does not exist and the response body is not the expected error shape. **Fix**: set `ACTUAL_API_URL` or pass `--api-url` (see `platform-advisor.md` → Endpoint Configuration).
- **`HTTP 400` on `org_id` from `advisor`** — the advisor requires a UUID `org_id`; if the signed-in org id is not a UUID, the request is rejected. **Fix**: pass `--org <uuid>`.
- **`HTTP 401`** — surfaced as `NotLoggedIn` (run `actual login`), not as `ApiError`.

These paths are reachable only by the platform commands; `adr-bot`'s `ApiError` / `ApiResponseError` come from the runner/tailoring API instead.

### AdrCreateUnconfirmed

**Cause**: A signed-in `actual adr create` reached Actual AI, but no answer came back, so the decision may have been saved. The CLI never retries it.

**Display**: "The save request was sent, but no answer came back (<error>). The decision may have been saved."

**Hint**: `actual adr list  (look for the decision in this repository's list before you run create again)`

**Fix**: Look for the decision with `actual adr list` before running `create` again. `create --all` stops at that file and lists the files after it under `not_sent`.

### AdrNotFound

**Cause**: No decision has the id given. Signed in, none of the organization's decisions has it; signed out, no file under `docs/adr/` names it in its header. `update` raises it too for a policy id the decision doesn't have.

**Display**: "No decision in your organization has the id <id>.", "No decision file under docs/adr/ has the id <id>." or "Decision <id> has no policy <policy id>; ..."

**Hint**: `actual adr list  (it prints each decision's id)`

**Fix**: Take the decision's id from `actual adr list` and its policy ids from `actual adr show <id>`.

### AdrNotAllowed

**Cause**: The decision's state doesn't allow the change, so nothing was sent or written: publishing a decision that's already active, restoring one that isn't archived, changing an archived one, or signed out, updating a file that isn't accepted or that holds text `update` would drop.

**Display**: What the state allows, such as "Only a draft can be published; this decision is active." or "An archived decision can't be changed; `actual adr restore <id>` brings it back first."

**Fix**: Run what the message names first, such as `actual adr restore <id>` or `actual adr publish <id>`, once the user agrees, or leave the decision as it is. For a file `update` won't write back, edit the file itself; the next `actual adr refresh` brings its rule file in step.

### AdrNotSaved

**Cause**: A signed-in `actual adr create` stopped before Actual AI saved anything: the save couldn't reach Actual AI, or the read of the repository's decisions before it failed.

**Display**: "Could not reach Actual AI, so the decision was not saved: <error>" or "Couldn't read the repository's decisions, so nothing was sent: <error>"

**Fix**: Nothing was saved. Check the network and the sign-in (`actual whoami`), then run the command again.

## Exit Code 1: General Runtime Errors

### RunnerFailed

**Cause**: The runner process exited with a non-zero status.

**Display**: `Runner failed: {message}\nstderr: {stderr}` — stderr output from the subprocess is shown inline.

**Hint**: Check the error details above. For subprocess runners, re-run with --verbose for more output.

**Diagnosis**:
```bash
actual adr-bot --verbose --show-errors  # get detailed output
# stderr from the runner subprocess is now included in the error message
```

**Fix**: Depends on the runner's error message. Common causes: model not available, rate limiting, context too large.

### RunnerOutputParse

**Cause**: The runner produced output that could not be parsed by the CLI.

**Hint**: The model may not be compatible with the runner or may have produced malformed output.

**Diagnosis**: Run with `--verbose` to see raw runner output.

**Fix**: Try a different model. Check `actual models` for known-compatible models.

### RunnerTimeout

**Cause**: The runner did not complete within `invocation_timeout_secs` (default: 600 seconds).

**Hint**: Increase the timeout or use a faster model.

**Diagnosis**:
```bash
actual config show  # check invocation_timeout_secs
```

**Fix**:
```bash
actual config set invocation_timeout_secs 1200  # double the timeout
```

### ConfigError

**Cause**: The configuration file has invalid YAML syntax or invalid values.

**Hint**: Check the config file for syntax errors.

**Diagnosis**:
```bash
actual config path   # find the config file
actual config show   # attempt to parse and display
```

**Fix**: Edit the config file to fix YAML syntax. Or reset:
```bash
# View the file
cat "$(actual config path)"
# Fix the YAML syntax, or delete to reset to defaults
```

### AnalysisEmpty

**Cause**: The analysis step produced no results, usually because the project path is empty or doesn't contain recognizable code.

**Hint**: Check that you're running in the correct directory and that the repo has code content.

**Diagnosis**:
```bash
pwd
ls -la
git log --oneline -5  # verify repo has commits
```

**Fix**: Ensure you're in the right directory. If using `--project`, verify the path exists.

### TailoringValidationError

**Cause**: The tailored output failed validation checks (e.g., the AI produced structurally invalid output).

**Hint**: Retry the sync. If persistent, use `--no-tailor` to skip AI tailoring.

**Fix**:
```bash
# Retry
actual adr-bot
# Or skip tailoring
actual adr-bot --no-tailor
```

### InternalError

**Cause**: An unexpected internal error occurred. This is likely a bug.

**Fix**: Report the error with reproduction steps.

### TerminalIOError

**Cause**: Failed to read from or write to the terminal (e.g., pipe closed, terminal capabilities missing).

**Fix**: Ensure you're running in a proper terminal. Try `--no-tui` to disable TUI mode.

### AdrInvalid

**Cause**: A decision failed a check before it could be saved: the save check `actual adr create` runs on the machine, a `--policy` or `--level` value that doesn't parse, a blank `update --title` or policy statement, or Actual AI's refusal of the content as it saves.

**Display**: "The decision can't be saved: <reason>", with one reason per line when there are several, such as "Add at least one policy."

**Fix**: Fix each reason in the flags or the file, then run the command again. Nothing was written or sent.

### AdrCheckFailed

**Cause**: `actual adr check` found decision files that fail the save check, or `actual adr create --all` didn't save a file. The report printed before the error names each file and why.

**Display**: "<n> of <m> decision files failed the check" from `check`, or "<n> of <m> decision files weren't saved" from `create --all`

**Fix**: Fix each failing file and run `actual adr check` again. After `create --all`, `not_saved` in its `--json` gives each file's reason.

### AdrDuplicate

**Cause**: A signed-in `actual adr create` found decisions in the repository that look like the one it was about to send, or the file it was given is already a decision in Actual AI, so it sent nothing.

**Display**: "This decision looks like one the repository already has, so nothing was sent:" followed by each look-alike's id and title, or "This file is already decision <id> in Actual AI (...), so nothing was sent."

**Hint**: `Run the same command with --allow-duplicate to save it anyway`, or `actual adr show <id>` for a file already saved

**Fix**: Show the user the decision it names (`actual adr show <id>`). Update that one instead, or pass `--allow-duplicate` only when the user wants both.

## Exit Code 4: User Cancelled

### UserCancelled

**Cause**: The user cancelled the operation (e.g., declined a confirmation prompt).

This is not an error. No action needed.

## Exit Code 5: I/O Errors

### IoError

**Cause**: A file I/O operation failed (read, write, create directory).

**Hint**: Check file permissions and available disk space.

**Diagnosis**:
```bash
# Check permissions on output file location
ls -la CLAUDE.md 2>/dev/null || echo "File does not exist"
ls -la . | head -5  # check directory permissions
df -h .  # check disk space
```

**Fix**: Fix file permissions or free disk space.

## Diagnosis Pattern

When encountering any error, follow this pattern:

1. **Match**: Identify the error from the CLI output. The CLI prints its message and, for some errors, a `Fix:` line, never the error's name, so match on the exit code and the message, which an entry's **Display** line quotes
2. **Look up**: Find the error in this catalog (use the summary table)
3. **Diagnose**: Run the diagnosis commands listed for that error
4. **Fix**: Apply the fix
5. **Verify**: Re-run the command that failed to confirm the fix worked

For comprehensive environment checks, use the diagnostic script:
```bash
# Resolve the active actual skill directory, then:
bash /absolute/path/to/actual/scripts/diagnose.sh
```
