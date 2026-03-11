# PR #50 Review: fix/hitl-ui-polish

**Reviewer:** Cloud Agent  
**Date:** 2026-03-11  
**Branch:** `fix/hitl-ui-polish`  
**Base:** `main` (comparing against commit `6834c07` which previously addressed issue #45)

---

## Executive Summary

**⚠️ CRITICAL ISSUES FOUND - DO NOT MERGE**

This PR appears to be a **regression** that undoes most of the improvements from the previous commit (6834c07) which addressed issue #45. The PR introduces a critical bug that will cause the stream to hang indefinitely when HITL approval is triggered.

---

## Critical Issues

### 🔴 P0: Stream Hang Bug - `pendingToolInputs` Not Cleaned Up

**Location:** `src/pipeline/respond.ts:773-924` (tool-approval-request handler)

**Issue:** The PR removes critical cleanup code that was present in commit 6834c07. When a `tool-approval-request` is received, the code fails to:

1. Remove the tool call from `pendingToolInputs` map
2. Clear the `toolKeepAlive` and `streamKeepAlive` intervals
3. Reset the inactivity timer
4. Add the tool call to `toolCallRecords`

**Impact:**
- The stream finalization logic waits for `pendingToolInputs.size === 0` (line 716-718, 761-763)
- Without cleanup, the map will never be empty
- Stream will not properly finalize after approval is granted
- Keepalive intervals will continue running, wasting resources
- The inactivity timer may trigger prematurely

**Code Missing (was present in 6834c07):**
```typescript
const pending = pendingToolInputs.get(approvalToolCallId);
toolCallRecords.push({
  name: approvalToolName,
  input: pending?.input ?? truncateToBytes(JSON.stringify(approvalInput), 1500),
  output: "Awaiting human approval",
  is_error: false,
});
if (approvalToolCallId) pendingToolInputs.delete(approvalToolCallId);

if (pendingToolInputs.size === 0 && toolKeepAlive) { 
  clearInterval(toolKeepAlive); 
  toolKeepAlive = null; 
}
if (pendingToolInputs.size === 0 && streamKeepAlive) { 
  clearInterval(streamKeepAlive); 
  streamKeepAlive = null; 
}
resetTimer();
```

**Fix Required:** Re-add the cleanup code after line 805 (after the task_update).

---

### 🔴 P0: Approval Status Change - "complete" vs "pending"

**Location:** `src/pipeline/respond.ts:797`

**Issue:** The PR changes the tool card status from `"pending"` to `"complete"` with the justification "Slack auto-marks unresolved tasks as error when stream closes."

**Current Code:**
```typescript
status: "complete",  // Was "pending" in 6834c07
```

**Analysis:**
This claim needs verification. The comment suggests that when `chat.stopStream()` is called, Slack automatically changes pending tasks to error status. However:

1. **No evidence provided** - This behavior is not documented in the Slack API docs
2. **Semantic incorrectness** - Marking a task as "complete" when it's actually "awaiting approval" is misleading
3. **User confusion** - Users will see a green checkmark when the tool is actually blocked
4. **Race condition potential** - If the status update happens BEFORE stopStream, and stopStream truly does modify task status, what happens?

**Questions:**
- Has this been tested? Does Slack actually change pending task status on stream close?
- If so, is there a way to prevent this (e.g., by not closing the stream until approval resolves)?
- Why is "complete" better than the error state Slack would apply?

**Recommendation:** 
- Provide evidence of the Slack behavior referenced in the comment
- Consider alternative solutions (e.g., keeping the stream open, using different status)
- If "complete" is necessary, add more detailed explanation in comments

---

### 🟡 P1: Regression - Approval Message Formatting Removed

**Location:** `src/lib/approval.ts:139-184` (removed functions)

**Issue:** The PR removes human-readable approval message formatting and reverts to raw JSON dumps:

**Removed Functions:**
- `truncateValue()` - Safely truncates long values
- `renderScalar()` - Renders primitive values
- `summarizeHttpRequest()` - Shows Method/URL/Body for HTTP requests
- `summarizeToolParams()` - Generic parameter summarization

**Before (6834c07):**
```
*Request details:*
*Method:* `POST`
*URL:* https://api.example.com/users
*Body (first 200 chars):* `{"name": "John", ...}`
```

**After (this PR):**
```
*Parameters:*
```
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "body": "{\"name\":\"John\", ...}"
}
```
```

**Impact:**
- Harder for approvers to quickly understand what the tool will do
- Raw JSON is less readable, especially for non-technical approvers
- HTTP requests lose the clear Method/URL/Body structure
- Nested JSON becomes difficult to parse visually

**Question:** Why was this removed? Was there a bug with the formatting, or a Slack rendering issue?

**Recommendation:** Keep the human-readable formatting from 6834c07 unless there's a specific technical reason to revert.

---

### 🟡 P1: Regression - Approval Message Not Updated After Execution

**Location:** `src/lib/hitl-resumption.ts:198-275`

**Issue:** The PR removes the logic that updates the original approval message with execution results, reverting to posting new messages in the thread.

**Before (6834c07):** 
- Approval message gets updated in-place with result summary
- Fallback to thread post if update fails
- Clean, consolidated UI

**After (this PR):**
- Always posts new message to thread
- Approval message remains unchanged with buttons
- Disconnected UX - user must scroll between approval and result

**Code Removed:**
- `updateApprovalMessage()` helper function
- Success path: updates approval message with result summary
- Failure path: updates approval message with error details
- Rejection path: updates approval message with rejection notice

**Impact:**
- Users see stale approval buttons after tool executes
- Harder to track what happened (approval + result are in different messages)
- Thread becomes cluttered with redundant messages

**Mitigation in PR:**
The PR re-adds UI update code to `src/app.ts` (lines 631-665) that shows intermediate states like "executing now..." and "completed". However:
- This is the BUTTON HANDLER, not the post-execution flow
- It doesn't update after the tool actually executes (that's in `hitl-resumption.ts`)
- So the approval message still shows buttons even after execution completes

**Recommendation:** Keep the `updateApprovalMessage()` logic from 6834c07 to provide clear feedback.

---

### 🟡 P1: Code Duplication in `app.ts`

**Location:** `src/app.ts:624-698`

**Issue:** The PR re-adds approval message update code that was previously consolidated in `hitl-resumption.ts`.

**Analysis:**
- Commit 6834c07 removed this code with comment: "Removes duplicate UI update code from app.ts button handlers (now handled canonically in hitl-resumption.ts)"
- This PR adds it back, creating duplication
- Now there are TWO places updating the approval message:
  1. `app.ts` - immediately after button click
  2. `hitl-resumption.ts` - (NO LONGER, because that code was removed)

**Current Flow:**
1. User clicks "Approve" button
2. `app.ts` updates message to "Approved by @user - executing now..."
3. `resumeConversationAfterApproval()` executes the tool
4. `app.ts` updates message again to "completed" or "execution failed"
5. Tool result gets posted to thread (not to approval message)

**Issues:**
- The approval message update happens BEFORE the tool executes (race condition)
- If `resumeConversationAfterApproval()` fails, the approval message may show "completed" when it actually failed
- Error handling is split between two files

**Recommendation:** Remove the duplication. Pick ONE place to handle approval message updates (preferably `hitl-resumption.ts` for better separation of concerns).

---

### 🟢 P2: Minor - "Expires in 10 minutes" Context Removed

**Location:** `src/lib/approval.ts:177`

**Issue:** The PR removes the expiry notice from approval messages.

**Before:**
```
admins • Expires in 10 minutes • `action_log_id: ...`
```

**After:**
```
admins • `action_log_id: ...`
```

**Impact:** Low - users lose awareness of approval timeout, but this is not critical functionality.

**Question:** Was there no actual timeout enforcement, making this message misleading?

---

### 🟢 P2: Minor - Tool Card Details Field Not Passed

**Location:** `src/pipeline/respond.ts:519-542` (removed code)

**Issue:** The PR removes the code that passes the `details` field from tool Slack metadata to the approval task card.

**Before (6834c07):**
```typescript
const details = approvalSlackMeta?.detail?.(approvalInput);
// ...
...(details && { details }),
```

**Impact:** Approval task cards won't show the detail line (e.g., URL for HTTP requests), making them slightly less informative.

---

### 🟢 P2: Removal of `approvalStatus` from `SlackToolMetadata`

**Location:** `src/lib/tool.ts:445-446`

**Issue:** The PR removes the `approvalStatus` field that allowed tools to customize their approval waiting message.

**Code Removed:**
```typescript
/** Optional title used when a tool is waiting on human approval */
approvalStatus?: string | ((input: TInput) => string | undefined);
```

**Impact:** Tools can no longer provide custom approval titles. All tools will show generic "Awaiting approval: {toolName}".

**Question:** Was this feature unused, or is this a regression?

---

## Type Safety & Error Handling

### ✅ No TypeScript Issues Detected (Manual Review)

I couldn't run `tsc --noEmit` due to TypeScript not being installed in the environment, but manual code review shows:
- No obvious type mismatches
- Proper null checks for `approvalToolCallId` (line 791)
- Proper optional chaining for approval message info (line 891)

### ⚠️ Missing Null Checks

**Location:** `src/app.ts:631-665`

**Issue:** The code checks `if (gaChanId && gaTs)` before calling `chat.update`, which is good. However, if these are missing, the approval flow continues silently without UI feedback.

**Recommendation:** Add logging or user notification when approval message update fails.

---

## Edge Cases & Race Conditions

### 🔴 Race Condition: Stream State When Approval Request Fires

**Scenario:**
1. Tool triggers approval request
2. Code sends `task_update` with status "complete" (line 792-805)
3. Code saves conversation state and posts approval buttons (line 807-921)
4. Stream continues to finalize... but `pendingToolInputs` was never cleaned up
5. Stream hangs waiting for pending tools

**Question:** What happens if `tryStreamAppend` fails due to streaming already failed? The code sets `streamingFailed` flag but doesn't abort the approval flow.

### 🔴 Race Condition: Button Click During Execution

**Scenario:**
1. Approval request is posted
2. User clicks "Approve" 
3. `app.ts` updates message to "executing now..."
4. `resumeConversationAfterApproval()` starts
5. User clicks "Approve" again (button still visible)
6. Second approval attempt runs

**Mitigation:** The atomic CAS in `handleApprovalReaction()` (line 346-360 in `approval.ts`) prevents double-approval. Good!

### 🟡 Missing Timeout Handling

**Question:** What happens if an approval expires (10 minutes mentioned in removed code)? There's no automatic cleanup or notification to the user.

---

## Testing Recommendations

If this PR is revised, the following scenarios must be tested:

1. **Happy path:** Tool needs approval → user approves → tool executes → result posted
2. **Rejection path:** Tool needs approval → user rejects → notification posted
3. **Stream survival:** Approval request doesn't break streaming (current PR WILL break this)
4. **Multi-approval:** Multiple tools need approval in one conversation
5. **Approval timeout:** What happens after 10 minutes?
6. **Channel types:** Test in DMs, public channels, private channels, threads
7. **Fallback mode:** What happens if streaming is disabled/fails?
8. **Error handling:** What if `resumeConversationAfterApproval()` throws?

---

## Recommendations

### Must Fix Before Merge:
1. ✅ Add back `pendingToolInputs` cleanup code (P0)
2. ✅ Investigate and document the "Slack auto-marks tasks as error" claim (P0)
3. ✅ Restore human-readable approval message formatting (P1)
4. ✅ Restore approval message updates after execution (P1)
5. ✅ Remove code duplication between `app.ts` and `hitl-resumption.ts` (P1)

### Should Fix:
6. ✅ Add back "Expires in 10 minutes" or implement actual timeout (P2)
7. ✅ Restore tool card `details` field (P2)
8. ✅ Consider restoring `approvalStatus` customization (P2)

### Question for Author:
- **Why was this PR created?** The commit message says "polish" but it's actually reverting most of 6834c07's improvements. Was there a production issue that necessitated the revert?
- **What specific problem does this solve?** Without context, this looks like a step backward.

---

## Conclusion

**This PR should not be merged in its current state.** It introduces a critical bug (stream hang) and regresses the UX improvements from commit 6834c07.

If there was a legitimate issue with 6834c07 that required these reverts, please:
1. Document the issue in the PR description
2. Fix the critical `pendingToolInputs` cleanup bug
3. Consider partial revert (only revert the problematic parts, keep the good parts)

Otherwise, I recommend **closing this PR** and using 6834c07's implementation.
