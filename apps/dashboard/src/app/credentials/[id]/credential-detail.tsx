"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  updateCredentialValue,
  grantCredentialAccess,
  revokeCredentialAccess,
  deleteCredential,
} from "../actions";
import { ArrowLeft, Trash2, UserPlus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Credential, CredentialGrant, CredentialAuditEntry } from "@schema";

interface CredentialData extends Credential {
  maskedValue: string;
  ownerName: string;
  grants: CredentialGrant[];
  granteeNames: Record<string, string>;
  auditLog: CredentialAuditEntry[];
}

export function CredentialDetail({ data }: { data: CredentialData }) {
  const router = useRouter();
  const [showUpdateValue, setShowUpdateValue] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [showGrant, setShowGrant] = useState(false);
  const [granteeId, setGranteeId] = useState("");
  const [permission, setPermission] = useState("read");

  async function handleUpdateValue() {
    if (!newValue) return;
    await updateCredentialValue(data.id, newValue);
    setShowUpdateValue(false);
    setNewValue("");
    router.refresh();
  }

  async function handleGrant() {
    if (!granteeId) return;
    await grantCredentialAccess(data.id, granteeId, permission, "dashboard");
    setShowGrant(false);
    setGranteeId("");
    router.refresh();
  }

  async function handleRevoke(grantId: string) {
    await revokeCredentialAccess(grantId, data.id);
    router.refresh();
  }

  async function handleDelete() {
    if (!confirm("Delete this credential?")) return;
    await deleteCredential(data.id);
    router.push("/credentials");
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href="/credentials">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold font-mono">{data.name}</h1>
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
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
        </CardContent>
      </Card>

      <Tabs defaultValue="grants">
        <TabsList>
          <TabsTrigger value="grants">Access Grants</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="grants">
          <div className="flex justify-end mb-2">
            <Button size="sm" onClick={() => setShowGrant(true)}>
              <UserPlus className="h-3.5 w-3.5 mr-1" /> Grant Access
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Grantee</TableHead>
                <TableHead>Permission</TableHead>
                <TableHead>Granted</TableHead>
                <TableHead>Revoked</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.grants.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell className="text-sm">{data.granteeNames[grant.granteeId] || grant.granteeId}</TableCell>
                  <TableCell><Badge variant="secondary">{grant.permission}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(grant.grantedAt)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(grant.revokedAt)}</TableCell>
                  <TableCell>
                    {!grant.revokedAt && (
                      <Button variant="outline" size="sm" onClick={() => handleRevoke(grant.id)}>Revoke</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data.grants.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                    No access grants
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
                  <TableCell className="text-sm">{entry.accessedBy}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entry.context}</TableCell>
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
          <Input type="password" placeholder="New value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowUpdateValue(false)}>Cancel</Button>
            <Button onClick={handleUpdateValue}>Update</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={showGrant} onOpenChange={setShowGrant}>
        <DialogHeader>
          <DialogTitle>Grant Access</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Grantee Slack User ID" value={granteeId} onChange={(e) => setGranteeId(e.target.value)} />
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px]"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="admin">Admin</option>
          </select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowGrant(false)}>Cancel</Button>
            <Button onClick={handleGrant}>Grant</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
