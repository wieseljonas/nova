# HITL Implementation (Current)

This document describes the current Human-in-the-Loop (HITL) flow for governed API writes in Nova.

## Scope

HITL currently applies to governed `http_request` tool executions that are classified as write operations and require approval.

HITL does not use the legacy policy engine anymore. It is credential-centric and enforced in tool execution + Slack approval actions.

## High-Level Architecture

1. LLM calls `http_request`.
2. `defineTool()` governance intercept in `apps/api/src/lib/tool.ts` checks credential access.
3. If write + authorized writer/owner: create approval proposal (`createProposal`).
4. Slack card is posted with Approve/Reject/Review buttons.
5. Approver action (`approval_approve_*`) marks approval approved and executes `executeBatchProposal`.
6. Batch executor performs requests sequentially and updates approval + Slack status.

## Core Files

- `apps/api/src/lib/tool.ts` - governance interception for `http_request`.
- `apps/api/src/lib/approval.ts` - access checks + approver resolution.
- `apps/api/src/lib/batch-executor.ts` - proposal creation, item execution, Slack card updates.
- `apps/api/src/app.ts` - Slack interaction handlers (`approval_approve_*`, `approval_reject_*`, `approval_review_*`).
- `apps/api/src/tools/http-request.ts` - governed external request tool.
- `apps/api/src/tools/approvals.ts` - explicit `propose_batch` tool.
- `packages/db/src/schema.ts` - `approvals`, `approval_items`, `credentials` schema.

## Data Model (Relevant Tables)

### `credentials`

Used for access control and approver resolution:

- `ownerUserId`
- `key`
- `readerUserIds` (read-only access)
- `writerUserIds` (write access + approver set)
- `approvalSlackChannelId` (optional channel override for approval cards)

### `approvals`

Tracks approval lifecycle and execution status:

- identity/context: `id`, `title`, `description`, `credentialKey`, `credentialOwner`
- request shape: `urlPattern`, `httpMethod`, `totalItems`
- state: `status` (`pending`, `approved`, `rejected`, `executing`, `completed`, `failed`)
- progress: `completedItems`, `failedItems`
- approver trace: `approvedBy`
- Slack linkage: `slackMessageTs`, `slackChannel`

### `approval_items`

Per-item execution rows:

- request payload: `method`, `url`, `body`, `headers`
- status: `pending`, `executing`, `succeeded`, `failed`, `skipped`
- execution output: `responseStatus`, `responseBody`, `error`, `executedAt`

## Governance Logic

Implemented in `checkAccess()` (`apps/api/src/lib/approval.ts`):

- Owner:
  - GET/HEAD/OPTIONS -> auto approve
  - write methods -> require approval
- Writer:
  - GET/HEAD/OPTIONS -> auto approve
  - write methods -> require approval
- Reader:
  - GET/HEAD/OPTIONS -> auto approve
  - write methods -> denied
- everyone else -> denied

In `defineTool()` (`apps/api/src/lib/tool.ts`):

- no credential:
  - GET/HEAD/OPTIONS allowed
  - write methods denied
- credential exists:
  - denied -> throw
  - auto_approve -> execute immediately
  - require_approval -> create proposal and return `awaiting_approval` result

## Proposal Creation

`createProposal()` in `apps/api/src/lib/batch-executor.ts`:

- writes one row in `approvals`
- writes N rows in `approval_items`
- resolves approvers from credential owner + writers (`getApprovers`)
- chooses approval channel:
  - credential-level `approvalSlackChannelId`, else requesting channel, else default env channel
- posts Slack card with:
  - approve, reject, review buttons
  - metadata containing `approval_id`

## Slack Action Handling

In `apps/api/src/app.ts` interactions endpoint:

- `approval_approve_<id>`
  - validate approval exists and is `pending`
  - authorize actor (`admin` OR credential owner/writer)
  - avoid duplicate approvals (`approvedBy` contains user)
  - append user to `approvedBy`
  - mark approval `approved`
  - execute `executeBatchProposal` directly

- `approval_reject_<id>`
  - same authorization checks
  - mark approval `rejected`
  - update Slack card to rejected state

- `approval_review_<id>`
  - open modal with first items for manual inspection

## Execution Path

Approval execution runs directly from the approve-action handler in `apps/api/src/app.ts`:

- approval is transitioned to `approved`
- `executeBatchProposal({ approvalId })` is invoked immediately
- executor updates statuses (`executing` -> `completed` / `failed`) and Slack card state

## Batch Execution Details

`executeBatchProposal()`:

- load approval, ensure `status === approved`
- mark `executing`
- load `approval_items` in sequence
- load credential value (`getApiCredentialWithType`)
- execute each HTTP item sequentially
- update item status + response payload
- maintain progress counters on `approvals`
- circuit breaker:
  - window: 50 items
  - threshold: >20% failures
  - remaining pending items marked `skipped`
- final status set to `completed` (with failure count in Slack text when needed)

## Auth Injection During Batch Execution

Batch execution now supports current credential format (`authScheme` + `value`):

- `bearer`, `oauth_client`, `google_service_account` -> `Authorization: Bearer ...`
- `basic` -> parse JSON or fallback to raw username, then build `Authorization: Basic ...`
- `header` -> parse `{ key, secret }` and set custom header
- `query` -> parse `{ key, secret }` and append to query string

## Security Properties

- Credential plaintext is never returned to LLM directly.
- Access checks are performed server-side against credential owner/writer/reader lists.
- Approval/rejection authorization is re-validated at click time (live credential lookup).
- Execution endpoint is protected by `CRON_SECRET`.

## Legacy Notes

- Legacy policy-driven approval system is removed from runtime path.
- Legacy `action_log` HITL table/fields were historical and are not part of current execution flow.

## Known Constraints

- Approval mode is currently single-step (`any_one` semantics in practice).
- Batch execution is sequential (no parallel execution).
- Slack card item review modal currently shows a capped preview set.

