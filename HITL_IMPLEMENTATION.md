# HITL (Human-in-the-Loop) Tool Approval System

## Overview

Nova now implements a comprehensive Human-in-the-Loop (HITL) approval system that gates high-risk tool calls behind human approval. When Nova attempts to execute a "destructive" tool, the conversation is paused, approval is requested via Slack, and execution resumes automatically after approval.

## Architecture

### Key Components

1. **Risk-Based Governance** (`src/lib/approval.ts`)
   - Tool calls are classified by risk tier: `read`, `write`, `destructive`
   - Approval policies are stored in the `approval_policies` table
   - URL pattern matching for granular control over HTTP requests

2. **Conversation State Persistence** (`src/db/schema.ts`)
   - When approval is needed, full conversation state is saved to `action_log.conversation_state`
   - Includes prompts, context, files, and all necessary state to resume execution
   - Approval message location tracked via `approval_message_ts` and `approval_channel_id`

3. **Tool Governance Interceptor** (`src/lib/tool.ts`)
   - Every tool call is logged to `action_log` table
   - Destructive-tier tools throw `PendingApprovalError` before execution
   - Conversation state automatically captured from `conversationStateStorage`

4. **Resumption Engine** (`src/lib/hitl-resumption.ts`)
   - `resumeConversationAfterApproval()`: Executes approved tool and continues conversation
   - `handleToolRejection()`: Notifies user when destructive action is rejected
   - Full conversation context restored from database

5. **Slack Integration** (`src/app.ts`)
   - Approval buttons post interactive messages with Approve/Reject options
   - Button handlers trigger resumption or rejection flows
   - Real-time UI updates show execution progress

### Data Flow

```
1. User requests destructive action
   ↓
2. Pipeline builds conversation state
   ↓
3. LLM attempts to call destructive tool
   ↓
4. Governance interceptor (tool.ts):
   - Logs to action_log with conversation_state
   - Posts approval request to Slack
   - Throws PendingApprovalError
   ↓
5. Conversation paused, waiting for approval
   ↓
6. Human clicks Approve/Reject
   ↓
7. Resumption handler (hitl-resumption.ts):
   - Retrieves conversation_state from action_log
   - Executes approved tool (or handles rejection)
   - Resumes LLM conversation with tool result
   - Posts continuation to Slack
```

## Database Schema

### action_log Table (Enhanced)

```typescript
{
  id: uuid (primary key)
  toolName: string
  params: jsonb
  triggerType: "user_message" | "scheduled_job" | "autonomous"
  triggeredBy: string (user ID)
  riskTier: "read" | "write" | "destructive"
  status: "executed" | "pending_approval" | "approved" | "rejected" | "failed"
  
  // HITL resumption fields (new)
  conversationState: {
    channelId: string
    threadTs?: string
    userId: string
    channelType: string
    userMessage: string
    stablePrefix: string           // System prompt
    conversationContext: string    // Thread history
    dynamicContext?: string        // Time, model info
    files?: any[]                  // Attached files
    teamId?: string
    timezone?: string
    modelId?: string
  }
  approvalMessageTs?: string       // Slack message timestamp
  approvalChannelId?: string       // Where approval was requested
  
  result: jsonb
  approvedBy?: string
  approvedAt?: timestamp
  createdAt: timestamp
}
```

### approval_policies Table

```typescript
{
  id: uuid (primary key)
  toolPattern?: string              // Tool name pattern
  urlPattern?: string               // URL pattern (for http_request)
  httpMethods?: string[]            // HTTP methods (GET, POST, etc)
  credentialName?: string           // Credential name to match
  riskTier: "read" | "write" | "destructive"
  approverIds?: string[]            // Slack user IDs who can approve
  approvalChannel?: string          // Channel to post approval requests
  createdBy: string
  createdAt: timestamp
}
```

## Usage

### Defining Approval Policies

```typescript
// Example: All DELETE requests are destructive
await db.insert(approvalPolicies).values({
  toolPattern: "http_request",
  httpMethods: ["DELETE"],
  riskTier: "destructive",
  approverIds: ["U123456", "U789012"],  // Admin user IDs
  approvalChannel: "C0GOVERNANCE",      // Post to #governance
  createdBy: "U123456",
});

// Example: Specific URL pattern
await db.insert(approvalPolicies).values({
  urlPattern: "https://api.production.com/**",
  httpMethods: ["POST", "PUT", "PATCH", "DELETE"],
  riskTier: "destructive",
  approverIds: ["U123456"],
  createdBy: "U123456",
});
```

### Approval Flow (User Perspective)

1. User: "Delete the production database backup from last week"
2. Nova: [Attempts to call destructive tool]
3. Nova posts approval request:
   ```
   🔒 Approval Required: http_request
   Risk tier: destructive
   Requested by: @user
   Trigger: user_message
   
   Parameters:
   {
     "url": "https://api.production.com/backups/123",
     "method": "DELETE"
   }
   
   [✅ Approve]  [❌ Reject]
   ```
4. Admin clicks "Approve"
5. Nova:
   - Executes the DELETE request
   - Resumes conversation
   - Posts result: "I've deleted the backup from last week. The operation completed successfully."

### Rejection Flow

1. Admin clicks "Reject"
2. Nova posts: "The requested action (`http_request`) was rejected by @admin. I won't proceed with that operation."
3. Conversation ends gracefully

## Configuration

### Environment Variables

- `AURA_ADMIN_USER_IDS`: Comma-separated Slack user IDs who can approve all requests (fallback when no policy-specific approvers)

### Default Risk Tiers

If no policy matches, HTTP methods default to:
- `GET`, `HEAD`, `OPTIONS`: `read`
- `POST`, `PUT`, `PATCH`: `write`
- `DELETE`: `destructive`

Named tools (non-HTTP) default to `write` unless a policy is defined.

## Implementation Notes

### AsyncLocalStorage for State

The system uses Node.js AsyncLocalStorage to thread conversation state through the execution:

```typescript
// Pipeline (respond.ts)
conversationStateStorage.run(conversationState, async () => {
  return await agent.stream(streamCallOptions);
});

// Tool wrapper (tool.ts)
const conversationState = conversationStateStorage.getStore();
// Available during tool execution
```

### Resumption Strategy

After approval, the system:
1. Re-creates the agent with original conversation context
2. Executes the tool in a fresh execution context (to avoid double-logging)
3. Generates a continuation prompt with the tool result
4. Posts the LLM's response to Slack

This approach ensures:
- Conversation continuity (LLM sees full context)
- Proper audit trail (tool execution logged separately)
- Natural responses (LLM integrates tool result into conversation)

## Testing

### Manual Test Flow

1. Create a destructive policy:
   ```sql
   INSERT INTO approval_policies (tool_pattern, risk_tier, approver_ids, created_by)
   VALUES ('http_request', 'destructive', ARRAY['YOUR_USER_ID'], 'YOUR_USER_ID');
   ```

2. In Slack, ask Nova to make an HTTP DELETE request
3. Verify approval message appears with buttons
4. Click "Approve"
5. Verify tool executes and conversation resumes

### Test Cases

- ✅ Destructive tool triggers approval
- ✅ Approval message posted to correct channel
- ✅ Approve button executes tool and resumes conversation
- ✅ Reject button cancels operation and notifies user
- ✅ Unauthorized user cannot approve (checked in handleApprovalReaction)
- ✅ Conversation state persisted and restored correctly
- ✅ Multiple approvals in same conversation work independently
- ✅ Job-triggered approvals handled (via jobId field)

## Migration

Run the migration to add HITL fields:

```bash
npm run db:migrate
```

This applies `drizzle/0035_add_hitl_resumption_fields.sql`:
```sql
ALTER TABLE "action_log" ADD COLUMN "conversation_state" jsonb;
ALTER TABLE "action_log" ADD COLUMN "approval_message_ts" text;
ALTER TABLE "action_log" ADD COLUMN "approval_channel_id" text;
```

## Future Enhancements

1. **Timeout for approvals**: Auto-reject if not approved within N hours
2. **Approval via thread reply**: Type "approve" or "reject" instead of buttons
3. **Batch approvals**: Approve multiple related actions at once
4. **Approval delegation**: Route to on-call engineer based on time
5. **Risk scoring**: ML-based risk assessment for dynamic tier assignment
6. **Audit UI**: Web dashboard to view all approval requests and history

## Related Files

- `src/lib/approval.ts` - Core approval logic
- `src/lib/tool.ts` - Tool governance interceptor
- `src/lib/hitl-resumption.ts` - Conversation resumption engine
- `src/pipeline/respond.ts` - Conversation state capture
- `src/app.ts` - Slack button handlers
- `src/db/schema.ts` - Database schema
- `drizzle/0035_add_hitl_resumption_fields.sql` - Migration

## Credits

Implemented as part of Nova's governance layer to ensure safe autonomous operation in production environments.
