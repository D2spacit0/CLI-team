# Business projects

Use the desktop project's authoritative state. Do not build a second task
register in messages or launch an extra CLI worker to bypass the scheduler.
Related requests continue in the same project; creating a new project requires
a new goal or explicit request. The first module produces one Xiaohongshu
image-and-text manuscript per cycle.

## Entry points

| Intent | MCP | CLI |
| --- | --- | --- |
| Find projects or inspect current work | `team_business_state` | `business-state [PROJECT_ID]` |
| Create an authorized project | `team_project_create` | `project-create` |
| Tell the owner a requirement or blocker | `team_project_message` | `project-message PROJECT_ID` |
| Submit a proposed fact, preference, or judgment | `team_project_fact` | `project-fact PROJECT_ID` |
| Import a specifically selected material | `team_project_material` | `project-material PROJECT_ID` |
| Read a fixed manuscript version | `team_content_preview` | `content-preview CONTENT_ID` |
| Return that version to its author | `team_content_revision_request` | `content-revise CONTENT_ID` |

Read the connected tool schema before supplying fields. CLI commands run as
`node tools/team.mjs COMMAND`. Use `--request-id` for writes and keep the same
identifier and body when retrying an uncertain response. A changed request
uses a new identifier. Never turn a timeout into a duplicate project or job.

`business-state` supports `projects`, `work`, `threads`, `facts`, `materials`,
`content`, `handoffs`, and `receipts` sections. Select `projectId` and, where
useful, `entityId`; follow `nextOffset` for the relevant section. Returned
truncation markers mean the text is incomplete. Do not infer omitted facts.

## Work and evidence

- The owner assigns workers and an independent receiver. `accepted` means the
  local scheduler admitted the attempt. `received` means the actual deliverable
  was collected with a fixed input/output identity. Only `verified` releases
  ordinary successors. A successful process exit or a member's summary does
  not replace these events.
- Source claims, machine collection receipts, and independent review remain
  separate. Materials submitted by this controller carry
  `controller_submission`; proposed facts carry `agent_claim` until the owner
  adopts them. Do not relabel them as user photographs or measured results.
- Failed, returned, and overdue work stays unfinished. The owner can explicitly
  retry, cancel, or defer it within the configured budget. Replanning preserves
  spent attempts for the same responsibility and keeps the original due date.
  Use a project message for a new instruction; do not directly edit SQLite or
  reset counters to get another execution.
- The service resumes valid local work with a fresh attempt and fixed inputs.
  An uncertain process tree remains quarantined. Do not launch another worker
  merely because a lease expired or its root PID disappeared.

## Reading and returning a manuscript

Start with `team_content_preview` section `summary`. Keep its returned `versionId`
for all subsequent reads. Read the `text` section through `nextTextOffset`,
and page `tags`, `images`, `sources`, `checks`, and `reviews` as needed. Summary
previews are abbreviated; they are insufficient for a full manuscript review.
Use the desktop workbench to inspect the actual ordered images.

Return concrete feedback with `contentId`, that exact `versionId`, `requestId`,
and `feedback`. A stale version is rejected: reload the current draft before
deciding whether the same concern still applies. Historical drafts and their
receipts remain available. Read-only inspection does not approve publication.

Publication approval is available only through the desktop's native final
confirmation, bound to the manuscript, image order, account, and time window.
There is no equivalent MCP or CLI approval action. An uncertain submission
must be reconciled before another attempt; never interpret it as a retryable
failure or claim publication without a verified platform record.

## Examples

```text
node tools/team.mjs business-state
node tools/team.mjs business-state PROJECT_ID --section work
node tools/team.mjs project-message PROJECT_ID --request-id REQUEST_ID --body "请根据已登记来源修改适用范围，保留原交付承诺。"
node tools/team.mjs content-preview CONTENT_ID --version VERSION_ID --section text --text-offset 0
node tools/team.mjs content-revise CONTENT_ID --version VERSION_ID --request-id REQUEST_ID --feedback "第二张图与正文步骤不一致，请统一并重新核验。"
```

The server's versioned workflow rules were informed by
[solo-to-team-skills](https://github.com/dabingfy-dot/solo-to-team-skills/tree/bc9c19458e9d4afe42e506fc65673a68c26c6a56).
Those rules guide handoffs; they grant no shell, credential, or publication
capabilities. Project conversations and the adjacent manuscript panel also
draw on [LibreChat](https://github.com/LibreChat-AI/LibreChat/tree/e6567c7a681ce67869dce31486a21d3a25d6931b).
