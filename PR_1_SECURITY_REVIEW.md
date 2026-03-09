# Security & Quality Review: PR #1 - Unified auth_scheme Credential Model

**PR**: https://github.com/wieseljonas/nova/pull/1  
**Reviewer**: Cloud Agent  
**Date**: 2026-03-09

## Executive Summary

This PR replaces the old `type` (token/oauth_client) + `token_url` credential model with a unified `auth_scheme` column supporting 5 auth methods: bearer, basic, header, query, oauth_client. The migration includes SQL migrations (0034, 0035), runtime migration fallback, App Home UI updates, and http_request tool support for all schemes.

**Overall Assessment**: The PR demonstrates solid migration design with idempotency, but contains **11 security/safety issues** ranging from CRITICAL to LOW severity that must be addressed.

---

## 🔴 CRITICAL SEVERITY FINDINGS

### C1. Runtime Migration Never Called - Data Loss Risk

**Severity**: CRITICAL  
**Category**: Migration Safety

**Issue**: The `runCredentialMigration()` function is defined but **never invoked** anywhere in the codebase. This means:

1. Migration 0035 will **drop the `token_url` column** immediately after 0034 runs
2. For `oauth_client` credentials with `token_url` in the old column, that data will be **permanently lost**
3. The runtime migration that folds `token_url` into the encrypted value blob never executes

**Evidence**:
```bash
$ grep -r "runCredentialMigration" src/
# Only shows definition, no invocation
```

The migration comment says "Safe to run only after the JS runtime migration has completed at least once" but there's no mechanism ensuring this happens.

**Impact**: Complete data loss for `oauth_client` credentials with `token_url` values.

**Fix Required**:
```typescript
// In src/db/migrate.ts or a startup hook
import { runCredentialMigration } from "../lib/api-credentials.js";

await migrate(db, { migrationsFolder: "./drizzle" });
await runCredentialMigration(); // Must run before 0035 applies
```

Or create a separate migration 0034.5 that calls the JS function, ensuring it runs between 0034 and 0035.

---

### C2. Unvalidated Header Name Injection

**Severity**: CRITICAL  
**Category**: Security - Header Injection

**Issue**: The `header` auth scheme allows arbitrary header names without validation. This enables HTTP header injection attacks.

**Vulnerable Code**:
```typescript:956:971:src/tools/http-request.ts
case "header": {
  let parsed: { key: string; secret: string };
  try {
    parsed = JSON.parse(credResult.value);
  } catch {
    return {
      ok: false as const,
      error: `Credential "${input.credential_name}" has auth_scheme header but its value is not valid JSON`,
    };
  }
  if (!parsed.key || !parsed.secret) {
    return {
      ok: false as const,
      error: `Credential "${input.credential_name}" must include key and secret for header auth`,
    };
  }
  headers[parsed.key] = parsed.secret; // ⚠️ NO VALIDATION
  break;
}
```

**Attack Vector**:
```json
{
  "key": "X-API-Key\r\nX-Admin: true",
  "secret": "malicious_token"
}
```

This injects a second header `X-Admin: true` via CRLF injection.

**Impact**: 
- Header injection attacks
- HTTP response splitting
- Session hijacking
- Bypassing security controls

**Fix Required**:
```typescript
// Validate header name against RFC 9110 field-name syntax
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

if (!HEADER_NAME_REGEX.test(parsed.key)) {
  return {
    ok: false as const,
    error: `Invalid header name "${parsed.key}" - must match RFC 9110 field-name syntax`,
  };
}

// Additional safeguard: reject any control characters
if (/[\x00-\x1F\x7F]/.test(parsed.key) || /[\x00-\x1F\x7F]/.test(parsed.secret)) {
  return {
    ok: false as const,
    error: "Header name and value must not contain control characters",
  };
}

headers[parsed.key] = parsed.secret;
```

Also add validation in `storeApiCredential()` for the `header` auth scheme.

---

### C3. Query Parameter Injection via Unvalidated Key Names

**Severity**: HIGH  
**Category**: Security - URL Injection

**Issue**: The `query` auth scheme doesn't validate parameter names, allowing injection of special characters that could break URL parsing or enable attacks.

**Vulnerable Code**:
```typescript:974:992:src/tools/http-request.ts
case "query": {
  let parsed: { key: string; secret: string };
  try {
    parsed = JSON.parse(credResult.value);
  } catch {
    return {
      ok: false as const,
      error: `Credential "${input.credential_name}" has auth_scheme query but its value is not valid JSON`,
    };
  }
  if (!parsed.key || !parsed.secret) {
    return {
      ok: false as const,
      error: `Credential "${input.credential_name}" must include key and secret for query auth`,
    };
  }
  const urlObj = new URL(requestUrl);
  urlObj.searchParams.set(parsed.key, parsed.secret); // Partial protection via URLSearchParams
  requestUrl = urlObj.toString();
  break;
}
```

**Analysis**: 
- `URLSearchParams.set()` does provide some encoding protection
- However, malicious parameter names with `&`, `=`, `#` could still cause issues
- No validation that the key is a reasonable query parameter name

**Attack Vector**:
```json
{
  "key": "api_key#evil_fragment",
  "secret": "token"
}
```

**Impact**: Medium - URL parsing issues, potential for fragment injection

**Fix Required**:
```typescript
// Validate query parameter name
const QUERY_PARAM_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

if (!QUERY_PARAM_REGEX.test(parsed.key)) {
  return {
    ok: false as const,
    error: `Invalid query parameter name "${parsed.key}" - must be alphanumeric with _-. only`,
  };
}
```

---

### C4. Basic Auth Password with Embedded Colons - Silent Corruption

**Severity**: HIGH  
**Category**: Security - Data Integrity

**Issue**: Basic auth encoding concatenates `username:password` with a colon separator. If the password contains colons, decoding becomes ambiguous and may fail on the server side.

**Current Code**:
```typescript:940:952:src/tools/http-request.ts
case "basic": {
  let basicParsed: { username: string; password: string };
  try {
    basicParsed = JSON.parse(credResult.value);
  } catch {
    return {
      ok: false as const,
      error: "basic credential value must be JSON {username, password}",
    };
  }
  const encoded = Buffer.from(
    `${basicParsed.username}:${basicParsed.password}`
  ).toString("base64");
  headers["Authorization"] = `Basic ${encoded}`;
  break;
}
```

**Problem**: 
- If `password = "pass:word:123"`, encoding produces `user:pass:word:123`
- Server decodes by splitting on **first** colon: `username=user`, `password=pass:word:123` ✅
- **However**, if username contains colons, it breaks: `user:name` + `pass` → `user:name:pass`
- Server splits on first colon: `username=user`, `password=name:pass` ❌

**RFC 7617** states: "username cannot contain a colon" but password can.

**Fix Required**:
```typescript
// Validate username doesn't contain colons (RFC 7617)
if (basicParsed.username.includes(':')) {
  return {
    ok: false as const,
    error: "Basic auth username must not contain colons (RFC 7617)",
  };
}

// Document that password CAN contain colons (this is safe)
const encoded = Buffer.from(
  `${basicParsed.username}:${basicParsed.password}`
).toString("base64");
```

Also add this validation in `storeApiCredential()`:
```typescript
} else if (authScheme === "basic") {
  try {
    const parsed = JSON.parse(plaintext);
    if (!parsed.username || !parsed.password) {
      throw new Error("basic value must contain username and password");
    }
    if (parsed.username.includes(':')) {
      throw new Error("Basic auth username must not contain colons (RFC 7617)");
    }
  } catch (e: any) {
    // ... existing error handling
  }
}
```

---

## 🟠 HIGH SEVERITY FINDINGS

### H1. Race Condition in Migration 0034 + 0035 Sequential Execution

**Severity**: HIGH  
**Category**: Migration Safety - Race Condition

**Issue**: There's a race condition window between migrations 0034 and 0035:

1. Migration 0034 adds `auth_scheme`, copies data, keeps old columns
2. **Runtime migration should fold `token_url` into value blobs**
3. Migration 0035 drops `type` and `token_url` columns

If deployments happen during this window, or if the runtime migration fails:
- New code reads from `auth_scheme` (doesn't exist yet) → crash
- Or 0035 runs before runtime migration → data loss

**Timeline Risk**:
```
T0: Deploy with 0034 applied (has auth_scheme + old columns)
T1: Runtime migration supposed to run but crashes
T2: Another deploy applies 0035 → drops token_url with data still there
T3: Data permanently lost
```

**Current Mitigation**: Migration 0035 comment says "Safe to run only after the JS runtime migration has completed at least once" but there's **no enforcement**.

**Fix Required**:
1. **Option A (Recommended)**: Create migration 0034.5 that calls a PL/pgSQL function to do the token_url folding in SQL:
   ```sql
   -- 0034.5_fold_token_url.sql
   DO $$
   DECLARE
     rec RECORD;
     decrypted_val TEXT;
     parsed_json JSONB;
   BEGIN
     FOR rec IN 
       SELECT id, value, token_url 
       FROM credentials 
       WHERE type = 'oauth_client' AND token_url IS NOT NULL
     LOOP
       -- Decrypt, add token_url, re-encrypt (requires implementing decrypt in PL/pgSQL or using a different approach)
       -- ... complex but safer
     END LOOP;
   END $$;
   ```

2. **Option B**: Add a guard in 0035:
   ```sql
   -- 0035_drop_legacy_credential_columns.sql
   DO $$
   BEGIN
     -- Only drop if all oauth_client rows have token_url in their value JSON
     IF EXISTS (
       SELECT 1 FROM credentials 
       WHERE type = 'oauth_client' 
         AND token_url IS NOT NULL
         AND NOT (value::text LIKE '%token_url%')
     ) THEN
       RAISE EXCEPTION 'Cannot drop token_url: some oauth_client credentials have not been migrated yet';
     END IF;
     
     ALTER TABLE credentials DROP COLUMN IF EXISTS type;
     ALTER TABLE credentials DROP COLUMN IF EXISTS token_url;
   END $$;
   ```

3. **Option C**: Delay 0035 to a future release, keep legacy columns for 2-3 deploys to ensure runtime migration runs.

---

### H2. Missing Audit Log for Auth Scheme Changes

**Severity**: HIGH  
**Category**: Security - Audit Trail

**Issue**: When updating a credential via the modal, the `auth_scheme` can be changed (e.g., from `bearer` to `basic`), but this change is **not logged** separately from the value change.

**Current Code**:
```typescript:756:783:src/app.ts
if (callbackId === "api_credential_update_submit" && userId) {
  const credentialId = payload.view?.private_metadata;
  const authScheme = (payload.view?.state?.values?.cred_auth_scheme_block?.cred_auth_scheme?.selected_option?.value || "bearer") as
    | "bearer"
    | "basic"
    | "header"
    | "query"
    | "oauth_client";

  const value = extractCredentialValue(payload.view?.state?.values, authScheme);

  if (credentialId && value) {
    const updatePromise = (async () => {
      try {
        const cred = await getCredentialById(credentialId);
        if (!cred) {
          recordError("interactions.api_credential_update.not_found", new Error("Credential not found"), { userId, credentialId });
          return;
        }

        const canWrite = await hasPermission(credentialId, userId, "write");
        if (!canWrite) {
          recordError("interactions.api_credential_update.forbidden", new Error("No write permission"), { userId, credentialId });
          return;
        }

        await storeApiCredential(
          cred.owner_id,
          cred.name,
          value,
          cred.expires_at ?? undefined,
          authScheme,  // ⚠️ Can change auth scheme without logging
        );
```

**Impact**: 
- Compliance violations (no audit trail of auth method changes)
- Security incident investigation is harder
- Can't track when a credential changed from `bearer` to `oauth_client` (significant change)

**Fix Required**:
Add audit logging before the update:
```typescript
const oldCred = await getCredentialById(credentialId);
if (oldCred.authScheme !== authScheme) {
  logger.warn("Credential auth scheme changed", {
    credentialId,
    credentialName: cred.name,
    userId,
    oldAuthScheme: oldCred.authScheme,
    newAuthScheme: authScheme,
  });
  // Optionally: call audit() function from api-credentials.ts
}
```

---

### H3. OAuth Client Credentials Leak in get_credential Tool Response

**Severity**: HIGH  
**Category**: Security - Information Disclosure

**Issue**: The `get_credential` tool returns different response shapes for oauth_client vs other schemes, but the oauth_client case returns the **access token in plaintext** in the tool response, which gets logged.

**Vulnerable Code**:
```typescript:902:907:src/tools/credentials.ts
if (result.authScheme === "oauth_client") {
  return {
    ok: true,
    auth_scheme: "oauth_client" as const,
    value: result.value,  // ⚠️ This is the access_token, returned in tool response
  };
}
```

**Issue**: The `value` here is the `access_token` from the OAuth exchange. This gets returned to the LLM, which may log it in tool call traces, debugging output, etc.

**Impact**: 
- Access tokens logged in AI SDK traces
- Potential exposure in error messages
- Tokens visible in tool call history

**Mitigation**: This may be intentional (the tool needs to return the token for use), but it should be documented. Consider:
1. Adding a comment explaining why the token is returned
2. Ensuring AI SDK tool traces don't log the full response
3. Using a separate field like `access_token` to make it explicit

**Fix Required**:
```typescript
if (result.authScheme === "oauth_client") {
  return {
    ok: true,
    auth_scheme: "oauth_client" as const,
    access_token: result.value,  // Renamed to make it explicit
    // Do NOT log this value in traces
  };
}
```

And update consumers to use `access_token` field.

---

## 🟡 MEDIUM SEVERITY FINDINGS

### M1. Inconsistent Error Handling in extractCredentialValue

**Severity**: MEDIUM  
**Category**: Error Handling

**Issue**: The `extractCredentialValue` helper returns `undefined` for all error cases (missing fields, invalid JSON), making it impossible to distinguish between "user didn't fill out the form" vs "malformed data".

**Code**:
```typescript:169:197:src/app.ts
function extractCredentialValue(
  values: Record<string, any> | undefined,
  authScheme: "bearer" | "basic" | "header" | "query" | "oauth_client"
): string | undefined {
  if (authScheme === "oauth_client") {
    const clientId = values?.cred_client_id_block?.cred_client_id?.value;
    const clientSecret = values?.cred_client_secret_block?.cred_client_secret?.value;
    const tokenUrl = values?.cred_token_url_block?.cred_token_url?.value;
    if (clientId && clientSecret && tokenUrl) {
      return JSON.stringify({ client_id: clientId, client_secret: clientSecret, token_url: tokenUrl });
    }
  } else if (authScheme === "basic") {
    const username = values?.cred_username_block?.cred_username?.value;
    const password = values?.cred_password_block?.cred_password?.value;
    if (username && password) {
      return JSON.stringify({ username, password });
    }
  } else if (authScheme === "header" || authScheme === "query") {
    const key = values?.cred_key_block?.cred_key?.value;
    const secret = values?.cred_secret_block?.cred_secret?.value;
    if (key && secret) {
      return JSON.stringify({ key, secret });
    }
  } else {
    return values?.cred_value_block?.cred_value?.value;
  }
  return undefined;  // ⚠️ Returns undefined for all failure cases
}
```

**Impact**:
- Silent failures when required fields are missing
- No user feedback on which field is missing
- Harder to debug form submission issues

**Fix Required**:
Make it return `{ ok: true, value: string } | { ok: false, error: string }`:
```typescript
function extractCredentialValue(
  values: Record<string, any> | undefined,
  authScheme: AuthScheme
): { ok: true; value: string } | { ok: false; error: string } {
  if (authScheme === "oauth_client") {
    const clientId = values?.cred_client_id_block?.cred_client_id?.value;
    const clientSecret = values?.cred_client_secret_block?.cred_client_secret?.value;
    const tokenUrl = values?.cred_token_url_block?.cred_token_url?.value;
    
    if (!clientId) return { ok: false, error: "Client ID is required" };
    if (!clientSecret) return { ok: false, error: "Client Secret is required" };
    if (!tokenUrl) return { ok: false, error: "Token URL is required" };
    
    return { 
      ok: true, 
      value: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token_url: tokenUrl })
    };
  }
  // ... similar for other schemes
}
```

---

### M2. No URL Validation for OAuth Token URL

**Severity**: MEDIUM  
**Category**: Security - SSRF

**Issue**: The `token_url` field in `oauth_client` credentials is not validated. An attacker could set it to:
- `http://localhost:6379/` (access internal Redis)
- `http://169.254.169.254/latest/meta-data/` (AWS metadata)
- `file:///etc/passwd`

**Vulnerable Code**:
```typescript:317:330:src/lib/api-credentials.ts
if (authScheme === "oauth_client") {
  try {
    const parsed = JSON.parse(plaintext);
    if (!parsed.client_id || !parsed.client_secret || !parsed.token_url) {
      throw new Error(
        "oauth_client value must contain client_id, client_secret, and token_url",
      );
    }
    // ⚠️ No validation of token_url format or scheme
  } catch (e: any) {
    // ...
  }
}
```

**Impact**: SSRF attacks to internal services

**Fix Required**:
```typescript
if (!parsed.client_id || !parsed.client_secret || !parsed.token_url) {
  throw new Error(
    "oauth_client value must contain client_id, client_secret, and token_url",
  );
}

// Validate token_url is HTTPS and not internal
try {
  const tokenUrl = new URL(parsed.token_url);
  if (tokenUrl.protocol !== 'https:') {
    throw new Error("token_url must use HTTPS");
  }
  
  // Block internal/private IPs
  const hostname = tokenUrl.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.')
  ) {
    throw new Error("token_url must not point to internal/private networks");
  }
} catch (e: any) {
  if (e.message.includes('token_url')) throw e;
  throw new Error("token_url must be a valid HTTPS URL");
}
```

---

### M3. TypeScript Version Bump Not Related to PR

**Severity**: LOW  
**Category**: Code Quality - Unrelated Changes

**Issue**: The PR includes a TypeScript version bump from `5.8.3` to `5.9.3`:

```diff:package.json
-    "typescript": "^5.8.3",
+    "typescript": "^5.9.3",
```

**Impact**: 
- Makes PR review harder (unrelated change)
- May introduce TypeScript behavior changes unrelated to credential changes
- Increases risk of unexpected build failures

**Fix Required**: Remove this change from the PR or document why it's necessary.

---

### M4. Missing Validation for Empty Strings in Credential Fields

**Severity**: MEDIUM  
**Category**: Data Integrity

**Issue**: The validation logic checks for presence (`if (!parsed.username)`) but empty strings pass this check in JavaScript:

```typescript
"" || "fallback"  // → "fallback" ✅
undefined || "fallback"  // → "fallback" ✅
```

However, the check uses:
```typescript
if (!parsed.username || !parsed.password) {
  throw new Error("basic value must contain username and password");
}
```

This correctly rejects empty strings. **However**, the JSON serialization from the modal could still allow whitespace-only values like `"   "`.

**Fix Required**:
```typescript
if (!parsed.username?.trim() || !parsed.password?.trim()) {
  throw new Error("basic value must contain non-empty username and password");
}
```

Apply to all auth schemes that use structured credentials.

---

## 🟢 LOW SEVERITY FINDINGS

### L1. Inconsistent Terminology: "Secret" vs "Value" vs "Token"

**Severity**: LOW  
**Category**: Code Quality - UX

**Issue**: Different auth schemes use different labels:
- bearer: "Value"
- basic: "Username", "Password"  
- header/query: "Key", "Secret"
- oauth_client: "Client ID", "Client Secret", "Token URL"

The term "secret" is overloaded (query secret, client secret) which could confuse users.

**Recommendation**: 
- Use "API Key" or "Token" for header/query secret
- Keep "Client Secret" for oauth_client
- Document the terminology in user-facing help text

---

### L2. No Unit Tests for New Auth Schemes

**Severity**: LOW  
**Category**: Code Quality - Testing

**Issue**: The PR doesn't include tests for:
- `extractCredentialValue` edge cases
- Each auth scheme in `http-request.ts`
- Header injection validation (once added)
- Migration logic

**Recommendation**: Add test coverage in a follow-up PR or before merging.

---

### L3. Missing JSDoc for Public Functions

**Severity**: LOW  
**Category**: Code Quality - Documentation

**Issue**: New exported functions lack JSDoc:
- `buildUpdateCredentialBlocks`
- `extractCredentialValue`

**Fix**: Add JSDoc comments:
```typescript
/**
 * Build Slack Block Kit blocks for the credential update modal.
 * Dynamically generates form fields based on the auth scheme.
 * 
 * @param authScheme - The authentication scheme (bearer, basic, header, query, oauth_client)
 * @returns Array of Slack Block Kit blocks
 */
export function buildUpdateCredentialBlocks(authScheme: AuthScheme = "bearer"): any[] {
  // ...
}
```

---

## API Contract Changes

### Breaking Changes

1. **`getApiCredentialWithType` return type changed**:
   ```typescript
   // OLD
   Promise<{ value: string; type: string; access_token?: string; expires_in?: number } | null>
   
   // NEW
   Promise<{ value: string; authScheme: AuthScheme } | null>
   ```
   
   **Impact**: Any code expecting `type` or `access_token` fields will break.
   
   **Consumers**: `src/tools/credentials.ts` (updated), `src/tools/http-request.ts` (updated)
   
   **Mitigation**: ✅ All consumers updated in the PR.

2. **`getJobApiCredential` return type changed**:
   ```typescript
   // OLD
   Promise<string | null>
   
   // NEW
   Promise<{ value: string; authScheme: AuthScheme } | null>
   ```
   
   **Impact**: Jobs expecting a plain string will break.
   
   **Consumers**: Need to search for all usages of `getJobApiCredential`.
   
   **Mitigation**: ⚠️ **Not verified** - need to check if any job code uses this function.

3. **`storeApiCredential` signature changed**:
   ```typescript
   // OLD
   (ownerId, name, value, expiresAt?, type?: "token" | "oauth_client", tokenUrl?: string)
   
   // NEW
   (ownerId, name, value, expiresAt?, authScheme?: AuthScheme)
   ```
   
   **Impact**: Calls passing `tokenUrl` will fail to compile.
   
   **Mitigation**: ✅ All consumers updated.

### Non-Breaking Changes

- Added `AuthScheme` type export from `api-credentials.ts`
- Added `extractCredentialValue` helper (internal to `app.ts`)
- Added `buildUpdateCredentialBlocks` export from `home.ts`

---

## Migration Safety Summary

### Data Loss Risks

1. **CRITICAL**: Runtime migration never called → `token_url` data lost when 0035 drops column
2. **HIGH**: Race condition between 0034 and 0035
3. **LOW**: Idempotency guards prevent duplicate constraint creation ✅

### Rollback Capability

**Can roll back after 0034?** ✅ Yes
- Old columns still exist
- `auth_scheme` has default value
- Old code can still read `type` column

**Can roll back after 0035?** ❌ No
- `type` and `token_url` columns dropped
- Old code will crash with "column does not exist"
- Data in `token_url` is permanently lost unless backed up

**Recommendation**: 
1. Run 0034 in production
2. Wait 1-2 weeks, monitor for issues
3. Manually verify all oauth_client credentials have `token_url` in their value blob
4. Only then run 0035 to drop legacy columns

---

## Edge Cases Review

### Bearer Auth
✅ Straightforward, no edge cases

### Basic Auth
- ⚠️ Colons in username → **HIGH severity finding H4**
- ⚠️ Colons in password → Safe (RFC 7617 allows this)
- ⚠️ Special chars in username/password → Should be safe with Base64 encoding
- ⚠️ Unicode in username/password → May cause issues with some APIs

### Header Auth
- ❌ CRLF injection → **CRITICAL finding C2**
- ⚠️ Case sensitivity → Different APIs expect different casing (X-API-Key vs x-api-key)
- ⚠️ Reserved headers (Host, Authorization) → Should these be blocked?

### Query Auth
- ⚠️ Special chars in key name → **HIGH finding C3**
- ✅ Special chars in value → Protected by `URLSearchParams.set()`
- ⚠️ Query param order → Some APIs validate signature based on param order
- ⚠️ Duplicate params → `URLSearchParams.set()` replaces, doesn't append

### OAuth Client
- ⚠️ SSRF in token_url → **MEDIUM finding M2**
- ⚠️ Invalid JSON in client_id/client_secret → Caught by validation ✅
- ⚠️ Token URL returns non-JSON → Handled by `exchangeOAuthToken` (existing code)
- ⚠️ Token exchange rate limiting → No retry logic (existing limitation)

---

## Recommendations Priority Order

### Must Fix Before Merge (CRITICAL)

1. **C1**: Invoke `runCredentialMigration()` at startup or create SQL-based migration
2. **C2**: Add header name validation to prevent injection
3. **C3**: Add query parameter name validation
4. **C4**: Validate username doesn't contain colons in basic auth

### Should Fix Before Merge (HIGH)

5. **H1**: Add safeguards for migration race condition (delay 0035 or add guard)
6. **H2**: Add audit logging for auth scheme changes
7. **H3**: Document/rename oauth_client token return value

### Should Fix in Follow-up PR (MEDIUM)

8. **M1**: Improve error handling in `extractCredentialValue`
9. **M2**: Add SSRF protection for token_url
10. **M3**: Remove TypeScript version bump or document rationale
11. **M4**: Validate no empty/whitespace-only credential values

### Nice to Have (LOW)

12. **L1**: Standardize terminology across auth schemes
13. **L2**: Add unit tests
14. **L3**: Add JSDoc comments

---

## Code Quality Assessment

### Strengths ✅
- Idempotent migrations with `IF NOT EXISTS` guards
- Good separation of concerns (UI blocks generation, extraction logic)
- Comprehensive support for 5 auth schemes
- Encrypted storage maintained
- Permission checks preserved

### Weaknesses ❌
- Missing input validation (header names, query params, URLs)
- Runtime migration never invoked
- No tests included
- Inconsistent error handling
- TypeScript version bump unrelated to PR

### Maintainability: 7/10
- Code is generally readable
- Some functions are getting long (e.g., `extractCredentialValue` switch statement)
- Good use of helper functions

---

## Final Verdict

**Recommendation**: **DO NOT MERGE** until CRITICAL and HIGH severity issues are resolved.

The migration design is solid with good idempotency, but the **runtime migration is never called**, which will cause data loss. Additionally, the **header injection vulnerability** is a serious security risk.

After fixes, this will be a well-designed credential system upgrade.

---

## Appendix: Testing Checklist

Before merging, test:

- [ ] Create a bearer credential, retrieve via `http_request`
- [ ] Create a basic credential with username `user@example.com` and password `p@ss:word`, verify encoding
- [ ] Create a basic credential with username `user:name`, verify rejection
- [ ] Create a header credential with key `X-API-Key`, verify header is set correctly
- [ ] Try to create header credential with key `X-API\r\nX-Evil: true`, verify rejection
- [ ] Create a query credential with key `api_key`, verify URL is modified correctly
- [ ] Create oauth_client credential with valid token_url, verify token exchange works
- [ ] Try to create oauth_client with token_url `http://localhost:6379`, verify rejection
- [ ] Update a credential from bearer to basic, verify auth scheme changes
- [ ] Verify all credential operations are audited correctly
- [ ] Test migration path: start with oauth_client+token_url, run 0034, verify runtime migration, run 0035
- [ ] Test rollback: run 0034, rollback code, verify old code still works
