# Platform Identity & Advisor Reference

Deep reference for the Actual AI platform commands — `login`, `logout`, `whoami`, and `advisor`. Load this when signing in, troubleshooting the OAuth flow, scoping an advisor query, or wiring the CLI to a local mock. These are **separate from `actual auth`**, which only checks the local coding-agent/runner used by `adr-bot`.

## Table of Contents

- [Platform Auth vs Runner Auth](#platform-auth-vs-runner-auth)
- [Endpoint Configuration](#endpoint-configuration)
- [login](#login)
- [Stored Credentials](#stored-credentials)
- [whoami](#whoami)
- [logout](#logout)
- [Token Refresh & Expiry](#token-refresh--expiry)
- [advisor](#advisor)
- [Scopes](#scopes)
- [Non-Interactive Playbook](#non-interactive-playbook)
- [Troubleshooting](#troubleshooting)

## Platform Auth vs Runner Auth

Two unrelated notions of "auth" exist in this CLI. Do not conflate them:

| | Runner auth (`actual auth`) | Platform identity (`actual login`) |
|---|---|---|
| What it checks | The local coding-agent/runner (claude / codex / cursor) used by `adr-bot` | Your Actual AI account + organization |
| How you authenticate | `claude auth login`, `OPENAI_API_KEY`, etc. | Browser OAuth via `actual login` |
| Used by | `actual adr-bot` (tailoring) | `actual advisor` (and future platform commands) |
| Stored where | Provider-specific (agent config, env vars) | `StoredCredentials` under the actual config dir |

`adr-bot` does **not** require `actual login`; `advisor` does **not** require runner auth.

## Endpoint Configuration

Production endpoints are built in; flags and environment variables override
them for staging, local development, or other deployments.

| Command | Source (in precedence order) |
|---|---|
| `login` | `--api-url <url>` → `ACTUAL_AUTH_URL` env var → `https://app.actual.ai` |
| `advisor` | `--api-url <url>` → `ACTUAL_API_URL` env var → built-in api-service default |

| Env var | Default | Purpose |
|---|---|---|
| `ACTUAL_AUTH_URL` | `https://app.actual.ai` | Auth server base URL for `login` |
| `ACTUAL_API_URL` | `https://api-service.api.prod.actual.ai` | Advisor API base URL for `advisor` |
| `ACTUAL_OAUTH_CLIENT_ID` | `actual-cli` | OAuth client id |
| `ACTUAL_OAUTH_SCOPES` | `openid profile offline_access adr:query adr:review` | Requested scopes |

The CLI is a **public OAuth client** — it holds no client secret and uses PKCE.

## login

`actual login` runs a standards-based browser OAuth flow:

1. Generates a PKCE verifier + S256 challenge (RFC 7636) and a CSRF `state`.
2. Starts an ephemeral `127.0.0.1` loopback listener (RFC 8252) as the redirect target.
3. Opens the browser to the authorization endpoint (and always prints the URL as a fallback).
4. The auth server redirects back to the loopback with `code` + `state`; the CLI validates `state`, exchanges `code` + `code_verifier` for tokens, resolves identity, and persists credentials.

### Flags

| Flag | Purpose |
|---|---|
| `--org <id>` | Pre-select an organization for a multi-org account. Single-org accounts auto-select. |
| `--api-url <url>` | Auth server URL (else `ACTUAL_AUTH_URL`, then production). |
| `--no-browser` | Print the authorize URL instead of launching a browser; still waits on the loopback. |

### Multi-org

The default consent flow asks a multi-org user which organization to authenticate to. Pre-select with `--org <id>` to skip the picker. A multi-org user who omits `--org` chooses in the browser; if the loopback redirect times out, the CLI's error hints to re-run with `--org`.

### Agent handoff (important)

`login` requires a human at a browser, so an **agent cannot complete it in a non-interactive shell**. The correct pattern is: check `whoami` first, and if logged out, hand off to the user (have them run `actual login`, or run `actual login --no-browser` and give them the printed URL). Resume automation once `whoami` succeeds. Never attempt to script the consent page.

## Stored Credentials

On success the CLI writes `StoredCredentials` to the config dir with `0600` permissions. The record holds the access token, refresh token, token type, expiry, granted scope, `organization_id`, `member_id`, account email/subject, and the auth URL. Tokens are **never** written to logs or `Debug` output (the `Debug` impl redacts them).

Config dir: `~/.actualai/actual/` (override with `ACTUAL_CONFIG` / `ACTUAL_CONFIG_DIR`).

## whoami

```bash
actual whoami
```

Prints the cached identity with **no network call**:

```
✔ Signed in to Actual AI
  Organization:  <organization_id>
  Account:       <email or subject>
  Member:        <member_id>
  Scopes:        <space-separated scopes>
```

Logged out → exits `2` ("Not signed in to Actual AI"). This is the cheapest pre-flight gate before `advisor`.

## logout

```bash
actual logout
```

Attempts a best-effort server-side token revoke (RFC 7009), then **always** clears the local credentials — so it succeeds even if the revoke call fails or you're already logged out.

## Token Refresh & Expiry

Credentials carry an expiry and a refresh token. `advisor` calls a transparent refresh before its request when the access token is expired or within ~60s of expiring: it rotates the refresh token (the old one is revoked) and re-persists. A refresh failure surfaces as `NotLoggedIn` (exit `2`) — the user must re-run `actual login`.

## advisor

`actual advisor "<question>"` asks an organization- or repository-scoped
architecture question. It is **non-interactive / agent-friendly** — no TTY
required.

### Flow

1. `POST /v1/advisor/query` starts an async job → `{ query_id, workflow_id, status }`.
2. The CLI polls `GET /v1/advisor/query/:query_id`, honoring the server's `Retry-After` between polls. Terminal results are `ETag`-cached (`If-None-Match` → `304`).
3. On `succeeded`, the CLI prints the answer; on `failed`, it surfaces the error and exits non-zero.

Progress (`advisor thinking…`) is written to **stderr**; the answer to **stdout** — so you can capture the answer cleanly.

### Flags

| Flag | Purpose |
|---|---|
| `--org <uuid>` | Organization to scope to. Defaults to the signed-in org. Must be a UUID. |
| `--repo <repo>` | Released v0.2.0: connected-repository UUID. Newer builds may also accept names, `owner/name`, `none`, and `auto`. |
| `--show-scope` | Newer builds only: print the remembered scope and exit without an API query; stored platform credentials are still required. |
| `--api-url <url>` | Advisor API URL (else `ACTUAL_API_URL`, else the default). |

### Output shape

A plain-text `summary`, then a "Related ADRs" list. Each related ADR carries: `id`, `name`, `title`, `policy`, `instructions`, `scope`, `relevance_reason`, and a `confidence` (0–1). There is **no `--json` flag yet** — output is human-readable text.

### Targeting a non-default endpoint

Point the advisor at a different server (local or staging) with `ACTUAL_API_URL` or `--api-url`:

```bash
ACTUAL_API_URL=https://your-advisor-endpoint actual advisor "How should I handle DB access in a new service?"
```

`--org` defaults to the signed-in org and is normally unnecessary — real organizations are UUIDs. Pass an explicit `--org <uuid>` only to override the organization. Without `--repo`, it performs a one-shot organization-level query without changing the remembered repository scope.

### Repository scope compatibility

Check `actual advisor --help` before selecting a scope workflow.

The released v0.2.0 CLI accepts a connected-repository UUID. Omitting `--repo`
runs the question at organization scope:

```bash
actual advisor --repo 3f2a1c9e-0000-0000-0000-000000000000 "..."
```

Newer builds may add repository-name resolution, remembered per-working-tree
scope, and `origin`-remote auto-detection:

```bash
actual advisor --repo actual-cli "How should this command report errors?"
actual advisor --repo actual-software/actual-cli "..."
actual advisor --show-scope
actual advisor --repo none
actual advisor --repo auto
```

For those newer builds, an explicit choice is remembered; without one, Advisor
matches the working tree's `origin` to a connected repository and falls back to
organization scope when no unique match exists. `none` pins organization scope,
while `auto` clears the pin. A repository literally named `none` or `auto` must
use `owner/name` or its UUID.

## Scopes

The login request asks for `openid profile offline_access adr:query adr:review` by default (override via `ACTUAL_OAUTH_SCOPES`). `offline_access` is what yields the refresh token used by [Token Refresh & Expiry](#token-refresh--expiry). `whoami` prints the scopes actually granted, which may differ from those requested.

## Non-Interactive Playbook

The end-to-end recipe an agent should follow to ask the advisor:

```bash
# 1. Optional endpoint overrides for staging/local deployments
export ACTUAL_AUTH_URL=...
export ACTUAL_API_URL=...

# 2. Pre-flight: are we signed in? (no network)
actual whoami || {
  # 3. Logged out → HAND OFF to the human. Do not script the browser.
  #    Ask them to run: actual login   (or: actual login --no-browser, then open the URL)
  echo "Sign in with 'actual login', then re-run."; exit 2;
}

# 4. Ask the advisor (agent-safe; no TTY needed)
actual advisor "your architecture question"
```

Treat exit `2` from any of these as "run `actual login`."

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Not signed in to Actual AI` (exit 2) | No / cleared credentials, or a failed token refresh | `actual login` |
| Login browser never returns | Multi-org user with no `--org`, or redirect timeout | Re-run `actual login --org <id>` |
| `API request failed: HTTP 404` from `advisor` | Pointed at the wrong base URL (e.g. the built-in default instead of your intended endpoint) | Set `ACTUAL_API_URL` or pass `--api-url` |
| `advisor` 400 on `org_id` | The endpoint requires a UUID org and the signed-in org id is not one | Pass `--org <uuid>` |
| Token expired mid-session | — | Handled transparently; only a refresh failure forces re-login |

> For the troubleshooting quick table and exit-code categories across the whole CLI, see `error-catalog.md`.
