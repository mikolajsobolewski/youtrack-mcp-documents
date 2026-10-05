# YouTrack MCP Documents

A YouTrack app that adds four read-only tools to the **existing official MCP
server**. No replacement server, agent skill, LLM, or search engine is required.
The app exposes tasks, KB articles, comments and issue history as structured
data suitable for agents and a future document synchronizer.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `rag_list_documents` | `kind: issue\|article`, `project`, optional `query`, `offset`, `limit` | Stable IDs, readable IDs, titles, URLs, timestamps; `nextOffset` |
| `rag_get_document` | `kind`, `id`, optional `contentOffset`, `contentLimit`, `expectedUpdatedAt` | Description/article text and metadata; `nextContentOffset` |
| `rag_get_comments` | `kind`, `id`, optional `offset`, `limit`, `expectedUpdatedAt` | Comment IDs, text, authors and timestamps; `nextOffset` |
| `rag_get_issue_history` | `id`, optional `offset`, `limit`, `start`, `end`, `categories` | Activity IDs, timestamps, old/new values; `nextOffset` and fixed `end` |

`id` inputs accept database IDs or readable IDs. The returned document `id`
combines the instance URL, entity kind and database ID, so renaming a title or
moving an entity does not create another identity. `sourceId` is the database
ID to pass to subsequent reads. Timestamps are Unix milliseconds.

Article enumeration uses the project's article collection. The optional `query`
is supported only for issues; article queries fail explicitly because the
article collection API does not support that filter.

Follow every continuation until it is `null`; `complete` means only that this
particular stream has ended. Text offsets count UTF-16 code units. The server
does not split surrogate pairs; use its returned offset rather than computing
one in a Python client. Text continuation requires the first page's
`expectedUpdatedAt`; `DOCUMENT_CHANGED` means restart the document.

Comments and history are separate streams, not silently included subsets.
History defaults to `CustomFieldCategory`, including State changes. Preserve
the returned `end` on subsequent requests. Other supported categories are
listed in the tool schema. Attachments/binary contents and historical article
revisions are not exported.

**Enumeration is non-atomic.** Offset pagination can race edits/deletions.
Responses explicitly mark `consistency: non_atomic`. A synchronizer must retry
changed sources, deduplicate IDs and validate complete inventories before
inferring deletions. A failed page must never publish a replacement snapshot.
This app does not claim transactional snapshots, change feeds or tombstones.

## Access model

Version 0.1 supports one configured exporter login and a project allowlist.
Before reading data, every tool:

1. Requires the MCP caller to equal `exporterLogin`.
2. Authenticates to REST using the secret app setting and checks `/api/users/me`
   against that same login.
3. Checks the parent document's project against `projectKeys`.

This prevents a privileged stored token from acting as a proxy for other MCP
callers. All data calls are GET requests to the administrator-configured HTTPS
host. Tool arguments cannot choose a URL or a REST path. HTTP failures, malformed
responses, invalid identities and missing configuration fail explicitly without
returning server bodies, secrets, or partial successful results.

This is not a multi-user exporter. REST visibility and MCP AI-specific visibility
can differ: enabling this app explicitly grants the configured exporter the
REST-visible data of the allowlisted projects. Do not enable it for a project
whose AI restrictions prohibit this. Returned text is untrusted source data.

## Build and test

Requires Node.js 22+ and Python 3.11+. There are no build/runtime npm dependencies.

```sh
npm run check
```

Runs unit tests, a green-baseline mutation check, JS syntax checks and a
deterministic ZIP build. `dist/youtrack-mcp-documents-0.1.0.zip` contains only the
seven allowlisted app files. A SHA-256 file is emitted beside it.

For JetBrains manifest validation:

```sh
npx --yes @jetbrains/youtrack-apps-tools@1.0.3 app validate --directory dist/app
```

After installation, compare MCP output with REST using the same exporter token:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-live.txt
.venv/bin/python scripts/verify_live.py --url https://tracker.example \
  --project PROJECT --issue PROJECT-1 --article PROJECT-A-1
```

Choose an issue with State transitions and comments, and a long KB article.
The read-only check verifies tool discovery, two inventory positions per kind,
full text reconstruction, every comment and custom-field history event for the
selected entities, plus explicit rejections for scope/revision/pagination errors.
It prints counts and hashes without document text or credentials and stops after
five minutes. This validates selected fixtures, not the entire project corpus.

## Install and configure

YouTrack 2025.3+ and permission to install apps are required. Build and test first.
Store a permanent token in `YT_TOKEN` or a private file (by default
`~/.config/youtrack-token`); never commit it. The token used for configuration
must belong to the configured exporter.

```sh
python3 scripts/deploy.py --url https://tracker.example \
  --configure --exporter-login alice --projects PROJECT
```

The deployment command uploads the tested ZIP and sets global app settings. It
uses the same app-management endpoints as the pinned JetBrains CLI 1.0.3; these
management endpoints may require adjustments after a YouTrack upgrade. For an
update preserving settings, omit `--configure` and the two scope arguments.
Alternatively upload the ZIP in Administration → Apps and fill the four settings.

Enable the app and add the package to your existing MCP URL:

```text
https://tracker.example/mcp?customToolPackages=youtrack-mcp-documents
```

Keep existing query parameters and package names when changing the URL. Retain
the existing MCP server name and authentication; the built-in tools remain
available. Reconnect/restart clients so they rediscover tools.

For Claude Code update `mcpServers.youtrack.url` in the project's `.mcp.json`.
For Codex update `mcp_servers.youtrack.url` in its configuration. Do not register
a second server with the same built-in tools. Preserve authentication and other
server settings when updating either configuration.

Rollback: remove this package from the MCP URL and reconnect. The original
server tools still work. Disable the app in YouTrack if it is no longer needed.

## References

- [Custom MCP tools](https://www.jetbrains.com/help/youtrack/devportal/custom-ai-tools.html)
- [App settings and secrets](https://www.jetbrains.com/help/youtrack/devportal/app-settings.html)
- [Issue activities](https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues-issueID-activities.html)
- [YouTrack apps tools](https://github.com/JetBrains/youtrack-apps/tree/main/packages/apps-tools)
