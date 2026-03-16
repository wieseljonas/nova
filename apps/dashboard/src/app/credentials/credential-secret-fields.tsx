"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AuthScheme, SecretPayloadInput } from "./credential-secret";

export function AuthSecretFields({
  authScheme,
  secret,
  setSecret,
}: {
  authScheme: AuthScheme;
  secret: SecretPayloadInput;
  setSecret: (updater: (prev: SecretPayloadInput) => SecretPayloadInput) => void;
}) {
  if (authScheme === "bearer") {
    return (
      <Input
        type="password"
        placeholder="Bearer token"
        value={secret.token ?? ""}
        onChange={(e) => setSecret((prev) => ({ ...prev, token: e.target.value }))}
      />
    );
  }

  if (authScheme === "basic") {
    return (
      <div className="space-y-2">
        <Input
          placeholder="Username"
          value={secret.username ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, username: e.target.value }))}
        />
        <Input
          type="password"
          placeholder="Password (optional)"
          value={secret.password ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, password: e.target.value }))}
        />
      </div>
    );
  }

  if (authScheme === "header" || authScheme === "query") {
    return (
      <div className="space-y-2">
        <Input
          placeholder={authScheme === "header" ? "Header key (e.g. X-API-Key)" : "Query key (e.g. api_key)"}
          value={secret.key ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, key: e.target.value }))}
        />
        <Input
          type="password"
          placeholder="Secret value"
          value={secret.secret ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, secret: e.target.value }))}
        />
      </div>
    );
  }

  if (authScheme === "oauth_client") {
    return (
      <div className="space-y-2">
        <Input
          placeholder="Client ID"
          value={secret.clientId ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, clientId: e.target.value }))}
        />
        <Input
          type="password"
          placeholder="Client secret"
          value={secret.clientSecret ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, clientSecret: e.target.value }))}
        />
        <Input
          placeholder="Token URL"
          value={secret.tokenUrl ?? ""}
          onChange={(e) => setSecret((prev) => ({ ...prev, tokenUrl: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <Textarea
      className="min-h-[140px] font-mono text-xs"
      placeholder='Paste full service account JSON (must include "private_key" and "client_email")'
      value={secret.serviceAccountJson ?? ""}
      onChange={(e) => setSecret((prev) => ({ ...prev, serviceAccountJson: e.target.value }))}
    />
  );
}
