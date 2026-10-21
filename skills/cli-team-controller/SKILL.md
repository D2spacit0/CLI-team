---
name: cli-team-controller
description: Control the local CLI Team workspace to delegate implementation, bounded multi-agent discussions, independent review and evidence-based acceptance while keeping controller context small.
---

# CLI Team Controller

Use for explicit team delegation, team messages, external reviews or CLI Team work.
This skill does not grant new filesystem, shell, credential or publishing permissions.

The CLI Team desktop app must already be running with the intended workspace.
The desktop app is the product entry point. Use its MCP tools if connected,
otherwise run `node tools/team.mjs` from the CLI Team project; set
`CLI_TEAM_WORKSPACE` if the desktop uses a different directory.

1. Read `status` or `inbox`, not raw conversation history.
2. Use `task` with an objective, scope, assignee, independent reviewer and
   explicitly authorized verification command. Work is isolated under `workspaces/`.
   For owner-led collaboration use `--delegate --members WORKER_A,WORKER_B`,
   or `team_task` with `executionMode:"delegated"` and `participantIds`.
   Select 1-4 permitted collaborators, excluding the owner and reviewer.
   Each member's manually entered skill description helps the owner choose
   suitable workers; it is not installed tooling, verified ability or permission.
3. Use `send` for direct member messages. Use `meeting` only for complex,
   genuinely disputed questions. The service limits rounds and handoffs.
4. Use blocking `wait` for checkpoints. Do not poll every tool event.
5. Read `evidence` only for the specific uncertainty or failed gate.
6. Accept only after checking gate status, artifact version and residual risks.
   Without automated verification, `--manual` is an explicit acknowledgement,
   not a way to override a failed or stale gate.
7. Use `revise` for a targeted correction and `cancel` to stop owned work.
8. Never automatically enable a second Codex CLI session or bypass permissions.
9. Use `dsh-list` and `dsh-import SESSION_ID` for read-only desktop progress.
   This does not transfer ownership. Never resume a live desktop session through
   a second writer or extract its private renderer capability. New DSH member
   jobs use ACP and a separate managed session directory.
10. A failed resume preserves the previous session ID. Do not silently start
    a replacement and lose context. After an explicit reset decision, use
    `reset-conversation --room ROOM_ID --to MEMBER_ID`; it removes only the
    workbench mapping and never deletes the original session or replays work.
11. When desktop control is unavailable, use an independent relay instead of
    bypassing its control interface: create `task --source-session SESSION_ID
    --draft` with a new explicit objective, import only authorized material
    copies using `import-material TASK_ID --file EXACT_FILE`, then `start TASK_ID`.
    The bounded source excerpt is not full conversation history. Never resume
    the original session or write back to the source as an implicit side effect.
    MCP equivalents are `team_task` with `sourceSessionId` and `start:false`,
    `team_materials` with `action:"import"` and an explicitly selected `file`,
    followed by `team_decide` with `action:"start"`.
12. Use `materials TASK_ID` or `team_materials` to check input hashes before
    dispatch. Import accepts one regular file at a time: 8 MiB per file, 32 MiB
    and 64 inputs per task. No recursive directory selection or credential files.
    Inputs are stored under `inputs/`; their hashes are recorded outside that
    directory. Do not manually stage unregistered files when this API applies.
13. Import/remove only before first execution. No overwrites, even on retry.
    Missing or altered inputs block work; create a new draft for changed material.
    Agent deliverables must be outside `inputs/`. An input is not a deliverable.
    Hash checks detect changes at checkpoints, not an OS sandbox.
14. Task command receipts intentionally omit repeated objectives and file bodies.
    Large material lists prioritize integrity failures and report omitted counts.
    Keep using checkpoint waits and targeted evidence rather than full run logs.
    Do not claim a measured token savings percentage without actual usage data.
15. Reuse one ordinary project channel for related work: create it once with
    `room --name NAME` or `team_room`, then pass `--room ROOM_ID` / `roomId` to
    every task. The CLI and MCP default to the lobby, not a new channel.
    Each task still has separate files, material locks, and member sessions.
    To reset a shared-channel task mapping, include `--task TASK_ID`.
16. Archive completed setup, tests, and cancelled attempts with `archive ID`
    or `team_decide action:"archive"`. Restore does not replay work and never
    deletes evidence. The normal status and UI omit archives; `status --archived`
    and the archive view retain access. Mark test tasks `category:"test"` and
    archive them in cleanup. Never archive running tasks or active channels.
17. Keep creative deliverables inside workbench tasks. Users can read verified
    text artifacts from the channel or task detail without leaving the workbench.
    A machine word-count gate is not a literary or continuity review.
18. When a member stalls or the team needs changing, use `pause TASK_ID` or
    `team_decide action:"pause"`, then `progress TASK_ID` / `team_progress`
    to confirm `active:false` and `canReassign:true`. Preserve the draft and
    reassign the SAME task with `assign TASK_ID --assignee MEMBER_ID
    --members WORKER_A,WORKER_B --reviewer MEMBER_ID --note REASON`, or
    `team_assign` with optional `participantIds` (omit to retain the pool).
    Members that previously wrote this task cannot become independent reviewers.
    Saving reassignment does not start a run or clear files, material locks,
    sessions or repair counts. Use `start` or `revise` with targeted feedback
    to continue; the new owner receives the reassignment note and prior results.
    Do not create a duplicate task just to switch a member.
19. Workers may ask the owner for help on their current step. The owner answers
    read-only, optionally consulting one other selected worker before replying.
    The requester and independent reviewer are excluded from that consultation.
    The service bounds help to two requests per step and six per task. A missing
    external fact or exhausted budget blocks work for explicit intervention.
20. Read `progress TASK_ID` / `team_progress` for current `assistance` records.
    When a current question is blocked and all task processes have stopped,
    save its reply with `answer TASK_ID --help-id HELP_ID --answer TEXT`, or
    `team_answer_assistance` with `taskId`, `helpId`, and `answer` (1-6000 chars).
    Saving ONLY records the answer. It does not start a run, pass a gate, change
    permissions or clear history. Inspect progress, then explicitly `start TASK_ID`
    / `team_decide action:"start"` when ready to continue. Use `revise` when scope
    or requirements need changing, rather than embedding new scope in an answer.
21. A step may declare file paths and formats or required analysis sections.
    Passing these checks proves file/structure conformance, not semantic
    correctness or final acceptance. Unconfigured checks remain explicit.
    Plans with output contracts for every step can resume locally: `resume`
    reports availability, reusable/total step counts and the reason. The service
    rechecks inputs, member runtime, dependencies and output hashes before
    reusing a completed step; changed or incomplete steps and their downstream
    steps execute again. Old plans without complete contracts replan on start.
    Reassignment or new revision feedback also triggers replanning while keeping
    existing files and history. Always inspect the final verification and review.

`team_external_sessions` provides the same read-only DSH inventory through MCP.
DSH discussions use a tool-free profile. Three consecutive tool failures stop
a run; inspect the cause instead of starting another identical retry loop.
An occasional unavailable tool in pure analysis is a warning, but still counts
toward that loop limit. Permission denial is always a failure.
Discussion completion and proposal approval are separate: a completed no-go
recommendation can finish the meeting without authorizing any implementation.
For a permitted editor, an explicitly rejected identical-text edit is a warning,
not proof of a successful write. The same applies to a read-before-edit guard
only when the target is inside the authorized workspace; the agent still has
to read the file before editing. Three repeated failures still stop the run.

Common commands:

```text
node tools/team.mjs status
node tools/team.mjs inbox
node tools/team.mjs send --room team --to antigravity-reviewer "Review this question."
node tools/team.mjs task --title "Task" --objective "Concrete requirement" --reviewer antigravity-reviewer
node tools/team.mjs task --draft --title "Copy task" --objective "Review provided inputs" --assignee dsh-builder --reviewer antigravity-reviewer
node tools/team.mjs import-material TASK_ID --file EXACT_FILE --name reference.txt
node tools/team.mjs materials TASK_ID
node tools/team.mjs start TASK_ID
node tools/team.mjs wait TASK_ID --timeout 60000
node tools/team.mjs pause TASK_ID --note "Adjust the team before continuing."
node tools/team.mjs progress TASK_ID
node tools/team.mjs answer TASK_ID --help-id HELP_ID --answer "Confirmed field and scope for the existing step."
node tools/team.mjs start TASK_ID
node tools/team.mjs evidence EVIDENCE_ID
node tools/team.mjs accept TASK_ID --note "Evidence checked"
```

Full logs remain in `.team/runs/`. Directory separation is not an OS sandbox.
Escalate new sensitive operations and unresolved important decisions to the user.
