# Security & Architecture Review: PR #25 - HITL Approval System

## Executive Summary

Reviewed 796 additions across 9 files implementing human-in-the-loop approval for destructive tool calls. Found **3 CRITICAL**, **3 HIGH**, **3 MEDIUM**, and **2 LOW** severity issues requiring attention before merge.

---

## 🔴 CRITICAL Severity Issues

### 1. Race Condition: Concurrent Approval/Rejection (CRITICAL)

**Location:** `src/lib/approval.ts:304-353`

**Issue:** Multiple users can approve/reject the same action simultaneously. The status check (line 304) and status update (lines 346-353) are not atomic, creating a TOCTOU (Time-Of-Check-Time-Of-Use) vulnerability.

```typescript
// Line 304: Check happens here
if (entry.status !== "pending_approval") {
  logger.info("handleApprovalReaction: action already resolved", {
    actionLogId,
    currentStatus: entry.status,
  });
  return;
}

// ... authorization logic ...

// Lines 346-353: Update happens here (NOT ATOMIC with check above)
await db
  .update(actionLog)
  .set({
    status: newStatus,
    approvedBy: reactorUserId,
    approvedAt: new Date(),
  })
  .where(eq(actionLog.id, actionLogId));
```

**Attack Scenario:**
1. User A clicks "Approve" at T+0ms
2. User B clicks "Reject" at T+5ms
3. Both pass the `status !== "pending_approval"` check
4. Both execute the update - last write wins
5. If A's update completes first, B's rejection overwrites the approval status but the tool has already been executed

**Impact:** Tool could be executed even after rejection, or approval status could be incorrect in audit log.

**Recommendation:**
```typescript
// Use optimistic locking with WHERE clause
const updateResult = await db
  .update(actionLog)
  .set({
    status: newStatus,
    approvedBy: reactorUserId,
    approvedAt: new Date(),
  })
  .where(
    and(
      eq(actionLog.id, actionLogId),
      eq(actionLog.status, "pending_approval") // Atomic check
    )
  )
  .returning({ id: actionLog.id });

if (updateResult.length === 0) {
  logger.info("handleApprovalReaction: action already resolved by another user", {
    actionLogId,
  });
  return;
}
```

---

### 2. Double Execution Vulnerability (CRITICAL)

**Location:** `src/app.ts:615-687`

**Issue:** `resumeConversationAfterApproval()` is called AFTER `handleApprovalReaction()` completes, not within the same transaction. If two users click "Approve" simultaneously, both could pass the race condition check and execute the tool twice.

```typescript
// Lines 619-625: First handler updates status
await handleApprovalReaction({
  actionLogId,
  reaction: "white_check_mark",
  reactorUserId: userId,
  slackClient,
});

// Lines 646-651: Second handler executes tool (NOT ATOMIC with above)
const result = await resumeConversationAfterApproval({
  actionLogId,
  approvedBy: userId,
  slackClient,
});
```

**Attack Scenario:**
1. Admin A clicks "Approve" at T+0ms
2. Admin B clicks "Approve" at T+10ms
3. Both pass the race condition check in `handleApprovalReaction`
4. Both call `resumeConversationAfterApproval`
5. Tool executes twice (e.g., DELETE request sent twice)

**Impact:** Destructive actions could be executed multiple times, causing data loss or unintended side effects.

**Recommendation:**
```typescript
// Add idempotency check in resumeConversationAfterApproval
const rows = await db
  .select()
  .from(actionLog)
  .where(eq(actionLog.id, actionLogId))
  .limit(1);

const entry = rows[0];
if (!entry) {
  return { ok: false, error: "Action log entry not found" };
}

// CRITICAL: Check if already executed
if (entry.status === "executed") {
  logger.warn("Tool already executed, skipping duplicate execution", {
    actionLogId,
  });
  return { ok: true }; // Return success to prevent UI errors
}

if (entry.status !== "approved") {
  return { ok: false, error: `Action status is ${entry.status}, expected 'approved'` };
}
```

Or better: use the existing `idempotencyKey` field:
```typescript
// In tool.ts when creating the pending approval
const idempotencyKey = `${toolName}-${Date.now()}-${crypto.randomUUID()}`;
const [logEntry] = await db.insert(actionLog).values({
  // ... existing fields ...
  idempotencyKey,
});

// In hitl-resumption.ts before executing
const alreadyExecuted = await db
  .select()
  .from(actionLog)
  .where(
    and(
      eq(actionLog.idempotencyKey, entry.idempotencyKey),
      eq(actionLog.status, "executed")
    )
  )
  .limit(1);

if (alreadyExecuted.length > 0) {
  return { ok: false, error: "Tool already executed (idempotency check)" };
}
```

---

### 3. Tool Re-execution Triggers Re-approval (CRITICAL)

**Location:** `src/lib/hitl-resumption.ts:113-120`

**Issue:** The approved tool is executed by calling `tool.execute()`, which goes through the governance interceptor (`defineTool` wrapper in `tool.ts`). This means the tool's risk tier will be re-evaluated and could trigger ANOTHER approval request.

```typescript
// Lines 113-120: Tool executed via governance wrapper
await executionContext.run(ctx, async () => {
  try {
    // @ts-ignore - We're calling the tool execute function directly
    toolResult = await tool.execute(entry.params);
  } catch (err) {
    toolError = err;
  }
});
```

The governance interceptor (`tool.ts:115-201`) will:
1. Look up the policy (line 133)
2. Check if risk tier is "destructive" (line 150)
3. Create a NEW `action_log` entry (lines 151-178)
4. Post a NEW approval request (lines 180-187)
5. Throw `PendingApprovalError` (line 200)

**Impact:** Infinite approval loop - approving a destructive tool triggers another approval request.

**Recommendation:**
Option 1: Skip governance check for approved executions:
```typescript
// Add flag to execution context
const ctx = {
  triggeredBy: state.userId,
  triggerType: "user_message" as const,
  channelId: state.channelId,
  threadTs: state.threadTs,
  skipGovernance: true, // NEW: Skip governance for approved execution
  conversationState: { ... },
};

// In tool.ts governance interceptor (line 150)
if (riskTier === "destructive" && !ctx.skipGovernance) {
  // ... approval logic ...
}
```

Option 2: Call the original execute function directly (bypass wrapper):
```typescript
// Store unwrapped execute function in tool metadata
export function defineTool<TInput, TOutput>(config: {
  description: string;
  inputSchema: ZodType<TInput, any, any>;
  execute: (input: TInput) => PromiseLike<TOutput>;
  slack?: SlackToolMetadata<TInput, TOutput>;
}) {
  const originalExecute = config.execute;
  
  // ... existing wrapper code ...
  
  (t as any).__originalExecute = originalExecute; // Store original
  
  return t;
}

// In hitl-resumption.ts, call original:
const originalExecute = (tool as any).__originalExecute;
if (originalExecute) {
  toolResult = await originalExecute(entry.params);
} else {
  // Fallback to wrapped version
  toolResult = await tool.execute(entry.params);
}
```

---

## 🟠 HIGH Severity Issues

### 4. Credential Exposure in Action Log (HIGH)

**Location:** `src/lib/tool.ts:151-178`

**Issue:** Raw tool parameters are stored in `action_log.params` BEFORE credential injection. However, for tools like `http_request`, users might pass credential values directly in params (e.g., `Authorization` header with token).

```typescript
// Line 153-159: Params stored before any sanitization
const [logEntry] = await db
  .insert(actionLog)
  .values({
    toolName,
    params: input as any, // RAW params, might contain secrets
    triggerType: ctx.triggerType,
    triggeredBy: ctx.triggeredBy,
    // ...
  })
```

**Impact:** Sensitive credentials visible in database and approval messages.

**Recommendation:**
```typescript
// Sanitize params before logging
function sanitizeParams(toolName: string, params: any): any {
  const sanitized = { ...params };
  
  if (toolName === "http_request") {
    if (sanitized.headers) {
      const headers = { ...sanitized.headers };
      // Redact common auth headers
      if (headers.Authorization) headers.Authorization = "[REDACTED]";
      if (headers["X-API-Key"]) headers["X-API-Key"] = "[REDACTED]";
      sanitized.headers = headers;
    }
  }
  
  // Redact credential_name references
  if (sanitized.credential_name) {
    sanitized.credential_name = `[credential: ${sanitized.credential_name}]`;
  }
  
  return sanitized;
}

// Use in action_log insert
params: sanitizeParams(toolName, input) as any,
```

---

### 5. Missing Transaction Boundaries (HIGH)

**Location:** `src/lib/approval.ts:346-376`

**Issue:** The approval flow updates `action_log` and `jobs` tables separately without a transaction. If the second update fails, the system is in an inconsistent state.

```typescript
// Lines 346-353: Update action_log
await db.update(actionLog).set({ ... });

// Lines 355-376: Update jobs (SEPARATE QUERY - not transactional)
if (entry.jobId) {
  if (isApproved) {
    await db.update(jobs).set({ ... });
  } else {
    await db.update(jobs).set({ ... });
  }
}
```

**Impact:** If `jobs` update fails, the action is approved but the job status doesn't reflect it.

**Recommendation:**
```typescript
import { db } from "../db/client.js";

// Wrap in transaction
await db.transaction(async (tx) => {
  const updateResult = await tx
    .update(actionLog)
    .set({
      status: newStatus,
      approvedBy: reactorUserId,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(actionLog.id, actionLogId),
        eq(actionLog.status, "pending_approval")
      )
    )
    .returning({ id: actionLog.id, jobId: actionLog.jobId });

  if (updateResult.length === 0) {
    throw new Error("Action already resolved");
  }

  const entry = updateResult[0];
  
  if (entry.jobId) {
    if (isApproved) {
      await tx.update(jobs).set({
        approvalStatus: null,
        pendingActionLogId: null,
        status: "pending",
      }).where(eq(jobs.id, entry.jobId));
    } else {
      await tx.update(jobs).set({
        approvalStatus: null,
        pendingActionLogId: null,
        status: "cancelled",
        result: `Rejected by <@${reactorUserId}>`,
      }).where(eq(jobs.id, entry.jobId));
    }
  }
});
```

---

### 6. Conversation State Injection Attack (HIGH)

**Location:** `src/lib/tool.ts:163-176`

**Issue:** Conversation state is serialized to JSONB without validation. Malicious input in user messages could inject arbitrary JSON that gets stored and later deserialized during resumption.

```typescript
conversationState: ctx.conversationState ? {
  channelId: ctx.channelId || "",
  threadTs: ctx.threadTs,
  userId: ctx.triggeredBy,
  channelType: ctx.conversationState.channelType || "dm",
  userMessage: ctx.conversationState.userMessage, // User-controlled
  stablePrefix: ctx.conversationState.stablePrefix,
  conversationContext: ctx.conversationState.conversationContext,
  dynamicContext: ctx.conversationState.dynamicContext,
  files: ctx.conversationState.files, // User-controlled
  teamId: ctx.conversationState.teamId,
  timezone: ctx.conversationState.timezone,
  modelId: ctx.conversationState.modelId,
} : null,
```

**Impact:** Potential for JSON injection or excessive storage consumption.

**Recommendation:**
```typescript
// Add size limits and validation
const MAX_CONVERSATION_STATE_SIZE = 100_000; // 100KB

function serializeConversationState(state: any): any {
  const serialized = JSON.stringify(state);
  
  if (serialized.length > MAX_CONVERSATION_STATE_SIZE) {
    // Truncate large fields
    return {
      ...state,
      conversationContext: state.conversationContext?.slice(0, 50000),
      userMessage: state.userMessage?.slice(0, 10000),
      files: state.files?.slice(0, 5), // Limit number of files
    };
  }
  
  return state;
}

// Use in action_log insert
conversationState: ctx.conversationState 
  ? serializeConversationState({
      channelId: ctx.channelId || "",
      // ... rest of fields ...
    })
  : null,
```

---

## 🟡 MEDIUM Severity Issues

### 7. Tool Result Update Not Atomic (MEDIUM)

**Location:** `src/lib/hitl-resumption.ts:126-133`

**Issue:** Tool result and status are updated in separate database operations. If the result update fails, status shows "executed" but result is empty.

```typescript
// Line 126-133: Result updated separately from status
await db
  .update(actionLog)
  .set({
    status: "executed",
    result: toolResult,
  })
  .where(eq(actionLog.id, actionLogId));
```

**Impact:** Incomplete audit trail - status shows success but no result stored.

**Recommendation:**
Combine in single update (already done correctly on line 126-133, but ensure no error paths split them):
```typescript
// Already correct, just ensure error handling preserves atomicity
try {
  await db.update(actionLog).set({
    status: "executed",
    result: toolResult,
  }).where(eq(actionLog.id, actionLogId));
} catch (dbErr) {
  // Log but don't fail - tool already executed
  logger.error("Failed to update action_log with result", {
    actionLogId,
    error: dbErr,
  });
  // Don't throw - this would trigger retry/failure notifications
}
```

---

### 8. Missing Size Validation for conversationState (MEDIUM)

**Location:** `src/db/schema.ts:559-574`

**Issue:** The `conversationState` JSONB field has no size constraints. Large conversation histories could exceed PostgreSQL's JSONB limits (1GB theoretical, but practical limits are much lower).

**Impact:** Database insertion could fail silently or cause performance degradation.

**Recommendation:**
Add validation in schema + application layer:
```typescript
// In schema.ts, add a check constraint
export const actionLog = pgTable(
  "action_log",
  {
    // ... existing fields ...
    conversationState: jsonb("conversation_state").$type<{
      // ... type definition ...
    }>(),
  },
  (table) => [
    // ... existing constraints ...
    check(
      "conversation_state_size_check",
      sql`pg_column_size(${table.conversationState}) < 102400` // 100KB limit
    ),
  ],
);
```

---

### 9. Stale Conversation State Risk (MEDIUM)

**Location:** `src/lib/hitl-resumption.ts:52-57`

**Issue:** No timestamp check to ensure conversation state isn't too old. Approving a request hours/days later could resume with stale context.

```typescript
const state = entry.conversationState;
if (!state) {
  // Legacy approval without conversation state - can't resume
  logger.warn("Cannot resume: no conversation state saved", { actionLogId });
  return { ok: false, error: "No conversation state available for resumption" };
}
// NO CHECK: How old is this state?
```

**Impact:** Resumption with outdated channel context, deleted messages, or changed permissions.

**Recommendation:**
```typescript
const MAX_STATE_AGE_HOURS = 24;

const state = entry.conversationState;
if (!state) {
  return { ok: false, error: "No conversation state available for resumption" };
}

// Check state age
const createdAt = new Date(entry.createdAt);
const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

if (ageHours > MAX_STATE_AGE_HOURS) {
  logger.warn("Conversation state too old, cannot resume", {
    actionLogId,
    ageHours,
  });
  return { 
    ok: false, 
    error: `Approval expired (${Math.floor(ageHours)}h old, max ${MAX_STATE_AGE_HOURS}h)` 
  };
}
```

---

## 🟢 LOW Severity Issues

### 10. Missing Approval Message Validation (LOW)

**Location:** `src/lib/hitl-resumption.ts:28-65`

**Issue:** No verification that the approval message still exists before resuming. If the message is deleted, the resumption notification has no context.

**Recommendation:**
```typescript
// Before resuming, verify approval message exists
if (entry.approvalMessageTs && entry.approvalChannelId) {
  try {
    const msgResult = await slackClient.conversations.history({
      channel: entry.approvalChannelId,
      latest: entry.approvalMessageTs,
      inclusive: true,
      limit: 1,
    });
    
    if (!msgResult.messages?.length) {
      logger.warn("Approval message deleted, resuming anyway", {
        actionLogId,
      });
    }
  } catch (err) {
    logger.warn("Could not verify approval message", {
      actionLogId,
      error: err,
    });
  }
}
```

---

### 11. No Rate Limiting on Approval Requests (LOW)

**Location:** `src/lib/approval.ts:144-278`

**Issue:** No rate limiting to prevent approval request spam. A malicious user could trigger many destructive tool calls to flood approval channels.

**Recommendation:**
```typescript
// Add to approval.ts
const approvalRateLimits = new Map<string, number[]>();
const MAX_APPROVALS_PER_USER_PER_HOUR = 10;

export async function requestApproval(args: { ... }): Promise<...> {
  const userId = args.context.userId;
  
  if (userId) {
    const now = Date.now();
    const userRequests = approvalRateLimits.get(userId) || [];
    const recentRequests = userRequests.filter(t => now - t < 3600_000);
    
    if (recentRequests.length >= MAX_APPROVALS_PER_USER_PER_HOUR) {
      throw new Error(
        `Approval rate limit exceeded (${MAX_APPROVALS_PER_USER_PER_HOUR}/hour)`
      );
    }
    
    approvalRateLimits.set(userId, [...recentRequests, now]);
  }
  
  // ... rest of function ...
}
```

---

## ✅ Migration Issues

### No Migration Collision Detected

✅ **VERIFIED:** Only one `0035_add_hitl_resumption_fields.sql` migration exists. No collision with existing migrations.

✅ **VERIFIED:** Migration syntax is correct and idempotent (uses `ADD COLUMN` which is safe).

---

## 📋 Additional Observations

### Architecture Concerns

1. **needsApproval Pattern Not Used**: PR description mentions "SDK-native needsApproval pattern" but the code implements a custom approval system. The Vercel AI SDK v6 doesn't appear to have a `needsApproval` primitive - this might be a documentation error.

2. **Resumption Strategy**: The approach of re-creating the agent and generating a continuation prompt (lines 193-217 in `hitl-resumption.ts`) is sound but could be improved:
   - Current: Generate new LLM response with synthetic tool result
   - Alternative: Continue from exact conversation state with tool result injected as proper tool-result message

3. **Error Notification**: Line 256 in `hitl-resumption.ts` posts raw tool result to Slack on continuation failure. This could leak sensitive data.

---

## 🎯 Recommendations Summary

### Must Fix Before Merge (CRITICAL):
1. ✅ Implement atomic status updates with optimistic locking (#1)
2. ✅ Add idempotency checks to prevent double execution (#2)
3. ✅ Skip governance check for approved tool executions (#3)

### Should Fix Before Merge (HIGH):
4. ✅ Sanitize params before logging to action_log (#4)
5. ✅ Wrap approval flow in database transaction (#5)
6. ✅ Add size validation for conversation state (#6)

### Can Fix After Merge (MEDIUM/LOW):
7. ⚠️ Add stale state timeout checks (#9)
8. ⚠️ Add rate limiting for approval requests (#11)
9. 📝 Improve error messages to avoid sensitive data leaks

---

## 🧪 Suggested Test Cases

Add integration tests for:

```typescript
describe("HITL Approval Security", () => {
  it("should prevent concurrent approvals (race condition)", async () => {
    // Create pending approval
    const actionLogId = await createPendingApproval();
    
    // Simulate concurrent approvals
    const [result1, result2] = await Promise.all([
      handleApprovalReaction({ actionLogId, reaction: "white_check_mark", ... }),
      handleApprovalReaction({ actionLogId, reaction: "white_check_mark", ... }),
    ]);
    
    // Only one should succeed
    const executed = await db.select().from(actionLog).where(eq(actionLog.id, actionLogId));
    expect(executed[0].status).toBe("approved");
    
    // Tool should execute exactly once
    const executionCount = await countToolExecutions(actionLogId);
    expect(executionCount).toBe(1);
  });
  
  it("should prevent double execution via concurrent resume calls", async () => {
    const actionLogId = await createApprovedAction();
    
    const [result1, result2] = await Promise.all([
      resumeConversationAfterApproval({ actionLogId, ... }),
      resumeConversationAfterApproval({ actionLogId, ... }),
    ]);
    
    // Only one should execute
    const executionCount = await countToolExecutions(actionLogId);
    expect(executionCount).toBe(1);
  });
  
  it("should not trigger re-approval when executing approved tool", async () => {
    const actionLogId = await createApprovedDestructiveTool();
    
    await resumeConversationAfterApproval({ actionLogId, ... });
    
    // Should not create new approval request
    const approvalCount = await db.select()
      .from(actionLog)
      .where(eq(actionLog.status, "pending_approval"));
    
    expect(approvalCount.length).toBe(0);
  });
  
  it("should reject stale approval requests", async () => {
    const actionLogId = await createApproval({ createdAt: oneDayAgo });
    
    const result = await resumeConversationAfterApproval({ actionLogId, ... });
    
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expired");
  });
});
```

---

## 📊 Final Verdict

**Overall Assessment:** 🟡 **CONDITIONAL APPROVAL**

The HITL approval system is well-architected and solves a real security need. However, **the 3 CRITICAL issues must be fixed before merge** to prevent:
- Race conditions leading to incorrect approval states
- Double execution of destructive tools
- Infinite approval loops

The HIGH severity issues should also be addressed to prevent credential leaks and ensure data consistency.

**Estimated Fix Effort:** 4-6 hours for CRITICAL + HIGH issues

**Recommended Next Steps:**
1. Fix CRITICAL issues #1-3 (atomic updates, idempotency, skip governance)
2. Fix HIGH issues #4-6 (credential sanitization, transactions, size limits)
3. Add integration tests for race conditions
4. Re-review and merge

---

**Reviewer:** AI Security Review (Claude Sonnet 4.5)  
**Date:** 2026-03-10  
**PR:** #25 - feat: HITL approval system - SDK-native needsApproval
