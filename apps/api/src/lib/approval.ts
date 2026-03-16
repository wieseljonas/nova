import { db } from "../db/client.js";
import { credentials, type Credential } from "@aura/db/schema";
import { eq, and } from "drizzle-orm";

// ── Access Check ────────────────────────────────────────────────────────────

/**
 * Simple access check for credential-based HTTP requests.
 * 
 * Access rules:
 * - Owner (ownerUserId) always has write access + is approver (implicit)
 * - readerUserIds can trigger GETs, auto-executed. Writes = denied.
 * - writerUserIds can trigger any method. Writes need approval from owner or another writer.
 * - No match = denied
 * 
 * @param credential The credential being accessed
 * @param userId The user requesting access
 * @param method The HTTP method (GET, POST, PUT, PATCH, DELETE, etc.)
 * @returns 'auto_approve' | 'require_approval' | 'denied'
 */
export function checkAccess(
  credential: Credential,
  userId: string,
  method: string
): 'auto_approve' | 'require_approval' | 'denied' {
  const methodUpper = method.toUpperCase();
  const isWrite = methodUpper !== 'GET' && methodUpper !== 'HEAD' && methodUpper !== 'OPTIONS';
  
  // Owner has full access
  const isOwner = credential.ownerUserId === userId;
  
  // Check if user is in writer list
  const writerIds = (credential.writerUserIds as string[]) ?? [];
  const isWriter = writerIds.includes(userId);
  
  // Check if user is in reader list
  const readerIds = (credential.readerUserIds as string[]) ?? [];
  const isReader = readerIds.includes(userId);
  
  // Owner or writer + write method -> require approval
  if ((isOwner || isWriter) && isWrite) {
    return 'require_approval';
  }
  
  // Owner or writer or reader + GET -> auto approve
  if ((isOwner || isWriter || isReader) && !isWrite) {
    return 'auto_approve';
  }
  
  // No access
  return 'denied';
}

/**
 * Get approvers for a credential (owner + writers).
 * Used when creating approval cards.
 */
export function getApprovers(credential: Credential): string[] {
  const writerIds = (credential.writerUserIds as string[]) ?? [];
  return [credential.ownerUserId, ...writerIds];
}

/**
 * Get the approval channel for a credential.
 * Returns the credential's approval_slack_channel_id if set, otherwise null.
 */
export function getApprovalChannel(credential: Credential): string | null {
  return credential.approvalSlackChannelId ?? null;
}

/**
 * Lookup a credential by name and owner.
 * Used by the approval/execution flow.
 */
export async function getCredentialForApproval(
  credentialName: string,
  credentialOwner: string
): Promise<Credential | null> {
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.key, credentialName),
        eq(credentials.ownerUserId, credentialOwner)
      )
    )
    .limit(1);
  
  return rows[0] ?? null;
}

/**
 * Check if a user is authorized to approve/reject an approval.
 * 
 * Authorization logic:
 * - If credential info is provided: checks if user is owner or writer of the credential
 * - Otherwise: returns false (caller should fallback to admin check)
 * 
 * @param credentialKey The credential key (if credential-based approval)
 * @param credentialOwner The credential owner user ID
 * @param userId The user attempting the action
 * @returns true if user is authorized, false otherwise
 */
export async function isAuthorizedApprover(
  credentialKey: string | null | undefined,
  credentialOwner: string | null | undefined,
  userId: string
): Promise<boolean> {
  if (!credentialKey || !credentialOwner) {
    return false;
  }

  const credential = await getCredentialForApproval(credentialKey, credentialOwner);
  if (!credential) {
    return false;
  }

  const isOwner = credential.ownerUserId === userId;
  const writerIds = (credential.writerUserIds as string[]) ?? [];
  const isWriter = writerIds.includes(userId);

  return isOwner || isWriter;
}
