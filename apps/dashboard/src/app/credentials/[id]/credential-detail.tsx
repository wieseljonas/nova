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
  deleteCredential,
} from "../actions";
import { ArrowLeft, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Credential, CredentialAuditEntry } from "@schema";

interface CredentialData extends Credential {
  maskedValue: string;
  ownerName: string;
  access: Array<{ userId: string; permission: 'read' | 'write' }>;
  userNames: Record<string, string>;
  auditLog: CredentialAuditEntry[];
}

export function CredentialDetail({ data }: { data: CredentialData }) {
  const router = useRouter();
  const [showUpdateValue, setShowUpdateValue] = useState(false);
  const [newValue, setNewValue] = useState("");

  async function handleUpdateValue() {
    if (!newValue) return;
    await updateCredentialValue(data.id, newValue);
    setShowUpdateValue(false);
    setNewValue("");
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

      <Tabs defaultValue="access">
        <TabsList>
          <TabsTrigger value="access">Access List</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="access">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Permission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.access.map((item) => (
                <TableRow key={item.userId}>
                  <TableCell className="text-sm">{data.userNames[item.userId] || item.userId}</TableCell>
                  <TableCell><Badge variant="secondary">{item.permission}</Badge></TableCell>
                </TableRow>
              ))}
              {data.access.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-muted-foreground py-4">
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

    </>
  );
}
