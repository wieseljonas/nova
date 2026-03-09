# PR #1 Review Summary - Unified auth_scheme Credential Model

## 🚨 CRITICAL - DO NOT MERGE UNTIL FIXED

### 1. Runtime Migration Never Called → Data Loss 🔴
**File**: `src/lib/api-credentials.ts:621`

The `runCredentialMigration()` function exists but is **never invoked**. When migration 0035 drops the `token_url` column, all oauth_client credentials will **permanently lose** their token URLs.

**Fix**: Call `runCredentialMigration()` at app startup before migrations run, or fold the logic into migration 0034.

---

### 2. HTTP Header Injection Vulnerability 🔴
**File**: `src/tools/http-request.ts:970`

The `header` auth scheme accepts **unvalidated header names**, enabling CRLF injection attacks:

```typescript
headers[parsed.key] = parsed.secret;  // ⚠️ NO VALIDATION
```

**Attack**: `{"key": "X-API-Key\r\nX-Admin: true", "secret": "token"}` injects malicious headers.

**Fix**: Validate header names against RFC 9110:
```typescript
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
if (!HEADER_NAME_REGEX.test(parsed.key) || /[\x00-\x1F\x7F]/.test(parsed.key)) {
  return { ok: false, error: "Invalid header name" };
}
```

---

### 3. Query Parameter Injection 🔴
**File**: `src/tools/http-request.ts:990`

Query parameter names are not validated before being added to URLs.

**Fix**: Validate query keys are alphanumeric:
```typescript
if (!/^[a-zA-Z0-9_\-\.]+$/.test(parsed.key)) {
  return { ok: false, error: "Invalid query parameter name" };
}
```

---

### 4. Basic Auth - Colons in Username Not Blocked 🔴
**File**: `src/tools/http-request.ts:949`, `src/lib/api-credentials.ts:337`

RFC 7617 **forbids colons** in usernames (but allows them in passwords). Current code doesn't validate this.

**Fix**: Add validation:
```typescript
if (parsed.username.includes(':')) {
  throw new Error("Basic auth username must not contain colons (RFC 7617)");
}
```

---

## 🟠 HIGH SEVERITY

### 5. Migration Race Condition
**Files**: `drizzle/0034_*.sql`, `drizzle/0035_*.sql`

Migration 0035 drops `token_url` column immediately after 0034 adds `auth_scheme`. If runtime migration doesn't run between them, **data is lost**.

**Fix**: Either delay 0035 to a later release, or add a guard:
```sql
IF EXISTS (
  SELECT 1 FROM credentials 
  WHERE type = 'oauth_client' AND token_url IS NOT NULL
  AND NOT (value::text LIKE '%token_url%')
) THEN
  RAISE EXCEPTION 'Cannot drop token_url: migration incomplete';
END IF;
```

---

### 6. Missing Audit Log for Auth Scheme Changes
**File**: `src/app.ts:782`

Changing a credential from `bearer` to `oauth_client` is a **significant security event** but isn't logged separately.

**Fix**: Add audit log before `storeApiCredential()`.

---

### 7. OAuth Access Tokens Leaked in Tool Responses
**File**: `src/tools/credentials.ts:902`

The `get_credential` tool returns access tokens in plaintext, which may be logged by the AI SDK.

**Fix**: Document this behavior or use a separate field name to make it explicit.

---

## 🟡 MEDIUM SEVERITY

### 8. Inconsistent Error Handling in extractCredentialValue
`extractCredentialValue()` returns `undefined` for all errors, making debugging hard.

**Fix**: Return `{ok: boolean, value?: string, error?: string}` pattern.

---

### 9. SSRF Risk in OAuth token_url
**File**: `src/lib/api-credentials.ts:319`

No validation prevents `token_url` from pointing to internal services (`http://localhost`, `169.254.169.254`).

**Fix**: Validate HTTPS + block private IPs.

---

### 10. Unrelated TypeScript Version Bump
`package.json` upgrades TypeScript `5.8.3 → 5.9.3` unrelated to this PR.

**Fix**: Remove or explain in separate commit.

---

### 11. Missing Validation for Empty/Whitespace Values
Whitespace-only values like `"   "` pass validation.

**Fix**: Add `.trim()` checks.

---

## 📋 API Contract Changes

### Breaking Changes ✅ (All consumers updated)

1. `getApiCredentialWithType()` return type: `type` → `authScheme`
2. `getJobApiCredential()` return type: `string` → `{value, authScheme}`
3. `storeApiCredential()` signature: removed `tokenUrl` param

### Migration Safety

- ✅ Can rollback after 0034 (old columns still exist)
- ❌ **Cannot rollback after 0035** (columns dropped, data lost)

---

## TypeScript Type Check

✅ **PASSED** - No type errors on PR branch

---

## Testing Checklist Required Before Merge

- [ ] Verify `runCredentialMigration()` is called at startup
- [ ] Test header injection attack is blocked
- [ ] Test basic auth with `username:colon` is rejected
- [ ] Test basic auth with `password:with:colons` works
- [ ] Test query param injection is blocked
- [ ] Test oauth_client SSRF protection
- [ ] Manual test: migrate existing oauth_client credential with token_url
- [ ] Verify all 5 auth schemes work end-to-end with http_request tool

---

## Recommendation

**DO NOT MERGE** until CRITICAL issues C1-C4 are fixed. HIGH severity issues should also be addressed before merge.

See `PR_1_SECURITY_REVIEW.md` for full detailed analysis with code references.
