"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  updateCredentialValue,
  updateCredentialMetadata,
  grantCredentialAccess,
  revokeCredentialAccess,
  updateCredentialAccessPermission,
  deleteCredential,
} from "../actions";
import { Combobox } from "@/components/ui/combobox";
import { AuthSecretFields } from "../credential-secret-fields";
import type { AuthScheme, SecretPayloadInput } from "../credential-secret";
import { ArrowLeft, Trash2, Eye, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Credential } from "@schema";

interface CredentialData extends Credential {
  maskedValue: string;
  ownerName: string;
  access: Array<{ userId: string; permission: "read" | "write" }>;
  userNames: Record<string, string>;
  knownUsers: Array<{ userId: string; label: string }>;
  auditLog: Array<{
    id: string;
    action: string;
    accessedBy: string;
    actorDisplayName: string;
    context: string | null;
    timestamp: Date;
  }>;
}

export function CredentialDetail({ data }: { data: CredentialData }) {
  const router = useRouter();
  const [showUpdateValue, setShowUpdateValue] = useState(false);
  const [actorUserId, setActorUserId] = useState(data.ownerUserId);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantPermission, setGrantPermission] = useState<"read" | "write">("read");
  const [metadataDisplayName, setMetadataDisplayName] = useState(data.displayName ?? "");
  const [metadataDescription, setMetadataDescription] = useState(data.description ?? "");
  const [metadataApprovalChannel, setMetadataApprovalChannel] = useState(data.approvalSlackChannelId ?? "");
  const [metadataExpiresAt, setMetadataExpiresAt] = useState(
    data.expiresAt ? new Date(data.expiresAt).toISOString().slice(0, 16) : "",
  );
  const [newSecret, setNewSecret] = useState<SecretPayloadInput>({});
  const [error, setError] = useState("");
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [isUpdatingValue, setIsUpdatingValue] = useState(false);
  const [isGranting, setIsGranting] = useState(false);
  const [auditDetailContext, setAuditDetailContext] = useState<string | null>(null);
  const [isUpdatingAccess, setIsUpdatingAccess] = useState<string | null>(null);
  const [permissionEdits, setPermissionEdits] = useState<Record<string, "read" | "write">>(
    Object.fromEntries(data.access.map((item) => [item.userId, item.permission])),
  );

  const grantOptions = data.knownUsers
    .filter((user) => user.userId !== data.ownerUserId)
    .filter((user) => !data.access.some((entry) => entry.userId === user.userId))
    .map((user) => ({ value: user.userId, label: user.label }));

  async function handleUpdateValue() {
    setError("");
    setIsUpdatingValue(true);
    try {
      await updateCredentialValue({
        credentialId: data.id,
        actorUserId,
        secret: newSecret,
      });
      setShowUpdateValue(false);
      setNewSecret({});
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update credential value");
    } finally {
      setIsUpdatingValue(false);
    }
  }

  async function handleSaveMetadata() {
    setError("");
    setIsSavingMetadata(true);
    try {
      await updateCredentialMetadata({
        credentialId: data.id,
        actorUserId,
        displayName: metadataDisplayName,
        description: metadataDescription,
        approvalSlackChannelId: metadataApprovalChannel,
        expiresAt: metadataExpiresAt || undefined,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update metadata");
    } finally {
      setIsSavingMetadata(false);
    }
  }

  async function handleGrant() {
    setError("");
    setIsGranting(true);
    try {
      await grantCredentialAccess({
        credentialId: data.id,
        actorUserId,
        granteeUserId: grantUserId,
        permission: grantPermission,
      });
      setGrantUserId("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant access");
    } finally {
      setIsGranting(false);
    }
  }

  async function handlePermissionUpdate(userId: string) {
    const nextPermission = permissionEdits[userId];
    if (!nextPermission) return;
    setError("");
    setIsUpdatingAccess(userId);
    try {
      await updateCredentialAccessPermission({
        credentialId: data.id,
        actorUserId,
        granteeUserId: userId,
        permission: nextPermission,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update access permission");
    } finally {
      setIsUpdatingAccess(null);
    }
  }

  async function handleRevoke(userId: string, permission: "read" | "write") {
    setError("");
    try {
      await revokeCredentialAccess({
        credentialId: data.id,
        actorUserId,
        granteeUserId: userId,
        permission,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke access");
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this credential?")) return;
    setError("");
    try {
      await deleteCredential({ credentialId: data.id, actorUserId });
      router.push("/credentials");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete credential");
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href="/credentials">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold font-mono">{data.key}</h1>
          <p className="text-sm text-muted-foreground">Owned by {data.ownerName}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary">{data.authScheme}</Badge>
          <Button variant="outline" size="sm" onClick={() => setShowUpdateValue(true)}>Update Value</Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="space-y-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <div className="col-span-2">
            <span className="text-muted-foreground">Acting User ID (owner or writer)</span>
            <Combobox
              options={data.knownUsers.map((u) => ({ value: u.userId, label: u.label }))}
              value={actorUserId}
              onChange={setActorUserId}
              placeholder="Select acting user"
              className="mt-1"
            />
          </div>
          <div>
            <span className="text-muted-foreground">Auth Scheme</span>
            <p className="font-mono">{data.authScheme}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Value</span>
            <p className="font-mono">{data.maskedValue}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{formatDate(data.createdAt)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Expires</span>
            <p>{formatDate(data.expiresAt)}</p>
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Display Name</span>
            <Input
              className="mt-1"
              value={metadataDisplayName}
              onChange={(e) => setMetadataDisplayName(e.target.value)}
              placeholder="Optional display name"
            />
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Description</span>
            <Textarea
              className="mt-1"
              value={metadataDescription}
              onChange={(e) => setMetadataDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div>
            <span className="text-muted-foreground">Approval Channel ID</span>
            <Input
              className="mt-1"
              value={metadataApprovalChannel}
              onChange={(e) => setMetadataApprovalChannel(e.target.value)}
              placeholder="Optional Slack channel ID"
            />
          </div>
          <div>
            <span className="text-muted-foreground">Expires At</span>
            <Input
              className="mt-1"
              type="datetime-local"
              value={metadataExpiresAt}
              onChange={(e) => setMetadataExpiresAt(e.target.value)}
            />
          </div>
          <div className="col-span-2 flex justify-end">
            <Button onClick={handleSaveMetadata} disabled={isSavingMetadata}>
              {isSavingMetadata ? "Saving..." : "Save Metadata"}
            </Button>
          </div>
          {error ? <p className="col-span-2 text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="access">
        <TabsList>
          <TabsTrigger value="access">Access List</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="access">
          <div className="mb-3 grid grid-cols-3 gap-2">
            <Combobox
              options={grantOptions}
              value={grantUserId}
              onChange={setGrantUserId}
              placeholder="Search users by name or Slack ID"
            />
            <Select value={grantPermission} onChange={(e) => setGrantPermission(e.target.value as "read" | "write")}>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </Select>
            <Button onClick={handleGrant} disabled={isGranting}>
              {isGranting ? "Granting..." : "Grant Access"}
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Permission</TableHead>
                <TableHead className="w-[220px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.access.map((item) => (
                <TableRow key={`${item.userId}-${item.permission}`}>
                  <TableCell className="text-sm">{data.userNames[item.userId] || item.userId}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{item.permission}</Badge>
                  </TableCell>
                  <TableCell className="flex items-center gap-2">
                    <Select
                      value={permissionEdits[item.userId] ?? item.permission}
                      onChange={(e) =>
                        setPermissionEdits((prev) => ({
                          ...prev,
                          [item.userId]: e.target.value as "read" | "write",
                        }))
                      }
                      className="h-8 w-24"
                    >
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePermissionUpdate(item.userId)}
                      disabled={isUpdatingAccess === item.userId}
                    >
                      Save
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleRevoke(item.userId, item.permission)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {data.access.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-4">
                    No additional access granted (owner only)
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="audit">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.auditLog.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell><Badge variant="secondary">{entry.action}</Badge></TableCell>
                  <TableCell className="text-sm">
                    <div>{entry.actorDisplayName}</div>
                    {entry.actorDisplayName !== entry.accessedBy ? (
                      <div className="text-xs text-muted-foreground">{entry.accessedBy}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {entry.context ? (
                      (() => {
                        try {
                          const parsed = JSON.parse(entry.context);
                          if (parsed.source === "http_request" && parsed.request?.method) {
                            const method = parsed.request.method;
                            const urlPath = (() => {
                              try { return new URL(parsed.request.url).pathname; } catch { return parsed.request.url; }
                            })();
                            const status = parsed.response?.status;
                            const statusColor = status && status < 400 ? "text-green-600" : "text-red-500";
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
                                onClick={() => setAuditDetailContext(entry.context)}
                              >
                                <Eye className="h-3 w-3 shrink-0" />
                                <span>{method}</span>
                                <span className="max-w-[180px] truncate">{urlPath}</span>
                                {status ? <span className={statusColor}>→ {status}</span> : null}
                              </button>
                            );
                          }
                          const summary = [parsed.source, parsed.request?.operation].filter(Boolean).join(" / ") || "details";
                          return (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              onClick={() => setAuditDetailContext(entry.context)}
                            >
                              <Eye className="h-3 w-3" />
                              {summary}
                            </button>
                          );
                        } catch {
                          return (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              onClick={() => setAuditDetailContext(entry.context)}
                            >
                              <Eye className="h-3 w-3" />
                              view
                            </button>
                          );
                        }
                      })()
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(entry.timestamp)}</TableCell>
                </TableRow>
              ))}
              {data.auditLog.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No audit entries
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>

      <Dialog open={showUpdateValue} onOpenChange={setShowUpdateValue}>
        <DialogHeader>
          <DialogTitle>Update Credential Value</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <AuthSecretFields authScheme={data.authScheme as AuthScheme} secret={newSecret} setSecret={setNewSecret} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowUpdateValue(false)}>Cancel</Button>
            <Button onClick={handleUpdateValue} disabled={isUpdatingValue}>
              {isUpdatingValue ? "Updating..." : "Update"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={auditDetailContext !== null} onOpenChange={(open) => { if (!open) setAuditDetailContext(null); }}>
        <DialogHeader>
          <DialogTitle>Audit Log Detail</DialogTitle>
        </DialogHeader>
        <AuditDetailContent context={auditDetailContext} />
      </Dialog>

    </>
  );
}

function JsonBlock({ label, data }: { label: string; data: unknown }) {
  if (data == null) return null;
  const formatted = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <pre className="max-h-[30vh] overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
        {formatted}
      </pre>
    </div>
  );
}

function AuditDetailContent({ context }: { context: string | null }) {
  if (!context) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(context);
  } catch {
    return (
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
        {context}
      </pre>
    );
  }

  if (parsed.source === "http_request" && (parsed.request?.method || parsed.response)) {
    const req = parsed.request;
    const res = parsed.response;
    const statusColor =
      res?.status && res.status < 400
        ? "text-green-600"
        : res?.status
          ? "text-red-500"
          : "text-muted-foreground";

    return (
      <div className="space-y-4 max-h-[70vh] overflow-auto">
        {req && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-semibold">Request</span>
              {req.method && (
                <Badge variant="secondary" className="font-mono text-xs">
                  {req.method}
                </Badge>
              )}
            </div>
            {req.url && (
              <p className="text-xs font-mono text-muted-foreground break-all">{req.url}</p>
            )}
            <JsonBlock label="Headers" data={req.headers} />
            <JsonBlock label="Body" data={req.body} />
          </div>
        )}

        {res && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <ArrowDownLeft className="h-4 w-4 text-green-500" />
              <span className="text-sm font-semibold">Response</span>
              {res.status && (
                <Badge variant="secondary" className={`font-mono text-xs ${statusColor}`}>
                  {res.status}
                </Badge>
              )}
              {res.error && (
                <span className="text-xs text-red-500">{res.error}</span>
              )}
            </div>
            <JsonBlock label="Headers" data={res.headers} />
            <JsonBlock label="Body" data={res.body} />
          </div>
        )}
      </div>
    );
  }

  return (
    <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}
