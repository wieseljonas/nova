"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pagination } from "@/components/pagination";
import { formatDate } from "@/lib/utils";
import { createCredential } from "./actions";
import { AuthSecretFields } from "./credential-secret-fields";
import type { AuthScheme, SecretPayloadInput } from "./credential-secret";
import { Combobox } from "@/components/ui/combobox";
import { Plus, Search } from "lucide-react";

interface CredentialRow {
  id: string;
  key: string;
  authScheme: string;
  ownerUserId: string;
  ownerName: string;
  expiresAt: Date | null;
  createdAt: Date;
  accessCount: number;
}

interface CredentialFilters {
  ownerUserId: string;
  authScheme: string;
  expired: string;
  hasAccessUserId: string;
}

interface Props {
  credentials: CredentialRow[];
  total: number;
  page: number;
  pageSize: number;
  knownUsers: Array<{ value: string; label: string }>;
  currentUserId: string;
  initialFilters: CredentialFilters;
}

export function CredentialsTable({ credentials, total, page, pageSize, knownUsers, currentUserId, initialFilters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newAuthScheme, setNewAuthScheme] = useState<AuthScheme>("bearer");
  const [newOwnerUserId, setNewOwnerUserId] = useState(currentUserId);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newApprovalChannel, setNewApprovalChannel] = useState("");
  const [newExpiresAt, setNewExpiresAt] = useState("");
  const [newSecret, setNewSecret] = useState<SecretPayloadInput>({});
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");
  const [ownerFilter, setOwnerFilter] = useState(initialFilters.ownerUserId);
  const [authSchemeFilter, setAuthSchemeFilter] = useState(initialFilters.authScheme);
  const [expiredFilter, setExpiredFilter] = useState(initialFilters.expired);
  const [hasAccessFilter, setHasAccessFilter] = useState(initialFilters.hasAccessUserId);

  function applyUrl(paramsUpdate: {
    search?: string;
    owner?: string;
    authScheme?: string;
    expired?: string;
    hasAccess?: string;
  }) {
    const params = new URLSearchParams(searchParams.toString());
    const entries: Array<{ key: keyof typeof paramsUpdate; value: string | undefined }> = [
      { key: "search", value: paramsUpdate.search },
      { key: "owner", value: paramsUpdate.owner },
      { key: "authScheme", value: paramsUpdate.authScheme },
      { key: "expired", value: paramsUpdate.expired },
      { key: "hasAccess", value: paramsUpdate.hasAccess },
    ];

    for (const entry of entries) {
      if (entry.value) {
        params.set(entry.key, entry.value);
      } else {
        params.delete(entry.key);
      }
    }

    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleSearch(value: string) {
    setSearchValue(value);
    applyUrl({
      search: value,
      owner: ownerFilter,
      authScheme: authSchemeFilter,
      expired: expiredFilter,
      hasAccess: hasAccessFilter,
    });
  }

  function handleFilterChange(next: {
    owner?: string;
    authScheme?: string;
    expired?: string;
    hasAccess?: string;
  }) {
    const owner = next.owner ?? ownerFilter;
    const authScheme = next.authScheme ?? authSchemeFilter;
    const expired = next.expired ?? expiredFilter;
    const hasAccess = next.hasAccess ?? hasAccessFilter;
    applyUrl({
      search: searchValue,
      owner,
      authScheme,
      expired,
      hasAccess,
    });
  }

  async function handleCreate() {
    setCreateError("");
    setIsCreating(true);
    try {
      await createCredential({
        key: newKey,
        authScheme: newAuthScheme,
        ownerUserId: newOwnerUserId,
        secret: newSecret,
        displayName: newDisplayName,
        description: newDescription,
        approvalSlackChannelId: newApprovalChannel,
        expiresAt: newExpiresAt || undefined,
      });
      setShowCreate(false);
      setNewKey("");
      setNewAuthScheme("bearer");
      setNewOwnerUserId(currentUserId);
      setNewDisplayName("");
      setNewDescription("");
      setNewApprovalChannel("");
      setNewExpiresAt("");
      setNewSecret({});
      router.refresh();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Failed to create credential");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search credentials..."
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-8 h-8 text-[13px]"
          />
        </div>
        <Input
          value={ownerFilter}
          onChange={(e) => {
            const value = e.target.value;
            setOwnerFilter(value);
            handleFilterChange({ owner: value });
          }}
          className="h-8 w-[180px] text-[13px]"
          placeholder="Filter owner ID"
        />
        <Select
          value={authSchemeFilter}
          onChange={(e) => {
            const value = e.target.value;
            setAuthSchemeFilter(value);
            handleFilterChange({ authScheme: value });
          }}
          className="h-8 w-[170px]"
        >
          <option value="">All auth schemes</option>
          <option value="bearer">Bearer</option>
          <option value="basic">Basic</option>
          <option value="header">Header</option>
          <option value="query">Query</option>
          <option value="oauth_client">OAuth Client</option>
          <option value="google_service_account">Google Service Account</option>
        </Select>
        <Select
          value={expiredFilter}
          onChange={(e) => {
            const value = e.target.value;
            setExpiredFilter(value);
            handleFilterChange({ expired: value });
          }}
          className="h-8 w-[130px]"
        >
          <option value="">Expiry: any</option>
          <option value="yes">Expired</option>
          <option value="no">Active</option>
        </Select>
        <Input
          value={hasAccessFilter}
          onChange={(e) => {
            const value = e.target.value;
            setHasAccessFilter(value);
            handleFilterChange({ hasAccess: value });
          }}
          className="h-8 w-[180px] text-[13px]"
          placeholder="Has access user ID"
        />
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead className="w-20">Auth Scheme</TableHead>
            <TableHead className="w-40">Owner</TableHead>
            <TableHead className="w-[70px]">Access</TableHead>
            <TableHead className="w-[140px]">Expires</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {credentials.map((cred) => (
            <TableRow key={cred.id}>
              <TableCell>
                <Link href={`/credentials/${cred.id}`} className="text-primary underline font-mono">
                  {cred.key}
                </Link>
              </TableCell>
              <TableCell><Badge variant="secondary">{cred.authScheme}</Badge></TableCell>
              <TableCell className="text-sm">{cred.ownerName}</TableCell>
              <TableCell>{cred.accessCount}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(cred.expiresAt)}</TableCell>
            </TableRow>
          ))}
          {credentials.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                No credentials found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pagination total={total} pageSize={pageSize} page={page} />

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogHeader>
          <DialogTitle>Add Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
          <Input placeholder="Key (lowercase, underscores)" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <Input
            placeholder="Display name (optional)"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
          />
          <Textarea
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
          <Input
            placeholder="Approval Slack channel ID (optional)"
            value={newApprovalChannel}
            onChange={(e) => setNewApprovalChannel(e.target.value)}
          />
          <Input type="datetime-local" value={newExpiresAt} onChange={(e) => setNewExpiresAt(e.target.value)} />
          <Select
            value={newAuthScheme}
            onChange={(e) => setNewAuthScheme(e.target.value as AuthScheme)}
          >
            <option value="bearer">Bearer</option>
            <option value="basic">Basic</option>
            <option value="header">Header</option>
            <option value="query">Query</option>
            <option value="oauth_client">OAuth Client</option>
            <option value="google_service_account">Google Service Account</option>
          </Select>
          <Combobox
            options={knownUsers}
            value={newOwnerUserId}
            onChange={setNewOwnerUserId}
            placeholder="Owner Slack User ID"
          />
          <AuthSecretFields authScheme={newAuthScheme} secret={newSecret} setSecret={setNewSecret} />
          {createError ? <p className="text-sm text-destructive">{createError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
