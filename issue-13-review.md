# Review: Consolidate 9 serverless functions into 1 entry point (Issue #13)

## Executive Summary

**Recommendation:** ⚠️ **PROCEED WITH EXTREME CAUTION** — The proposal is technically sound for regular HTTP routes, but there's a **critical unverified assumption** about Vercel cron job behavior with rewrites that could cause silent failures.

---

## 1. Feasibility Analysis

### ✅ What Works

The core idea is sound:
- All 9 current files are identical thin wrappers calling `handle(app)` from the same Hono app
- Hono handles routing internally via path matching (lines 59-908 in `src/app.ts`)
- Regular HTTP traffic (Slack events, OAuth callbacks, webhooks) will work perfectly through rewrites
- Build time will definitely improve (~30-60s savings is realistic)

### 🚨 CRITICAL UNCERTAINTY: Cron Jobs + Rewrites

**The issue assumes cron jobs will work through rewrites, but I cannot find definitive proof.**

**What Vercel docs say:**
- "Cron jobs do not follow redirects" ✅ (but rewrites ≠ redirects, so this is fine)
- "The path must match a deployed serverless function" ⚠️ (ambiguous)
- "Cron jobs will execute even for paths that don't exist, but will return a 404" ⚠️ (contradictory)

**The critical question:** Do cron invocations pass through Vercel's edge network routing layer (where rewrites are applied), or do they route directly to function files?

**Evidence gathered:**
- Vercel cron jobs send HTTP GET requests to `https://<production-url><path>`
- Rewrites are part of the edge network layer, applied to all HTTP requests
- **However**, I found NO real-world examples or explicit documentation confirming cron paths resolve via rewrites
- The docs phrase "path must match a deployed serverless function" suggests direct file mapping may be required

**If rewrites DON'T apply to cron invocations:**
- `/api/cron/heartbeat` will 404 (no function file exists after deletion)
- `/api/cron/consolidate` will 404
- **Cron jobs will silently fail** — Vercel will log the invocation but return 404
- Memory consolidation (daily at 4 AM) stops running
- Heartbeat (every 30 min) stops running → jobs queue up, stale jobs aren't recovered

---

## 2. Risks Assessment

### Risks Identified in Issue

✅ **Cron jobs may break** — Confirmed as the #1 risk  
✅ **Cold start behavior changes** — Analyzed below

### Additional Risks Not Mentioned

#### 🔴 **Silent Failure Mode**
If cron paths don't resolve via rewrites:
- No deployment errors (deploy succeeds)
- No runtime errors (404s are logged but don't crash)
- Cron jobs appear to run (Vercel invokes them on schedule)
- **But they fail silently** — you won't know unless you actively monitor cron job response codes

**Mitigation:** Set up monitoring for cron job failures BEFORE deploying this change.

#### 🟡 **Vercel Build Cache Invalidation**
Deleting 8 function files may confuse Vercel's build cache:
- Build system expects certain function outputs
- Removing them could trigger full rebuild or cache miss
- **Impact:** First deploy after this change might be slower than expected

#### 🟡 **Rewrite Order Matters**
The proposed rewrite config has a catch-all at the end:
```json
{ "source": "/(.*)", "destination": "/api/index" }
```

**Problem:** The earlier rewrites are redundant:
```json
{ "source": "/api/cron/:path*", "destination": "/api/index" },
{ "source": "/api/slack/:path*", "destination": "/api/index" },
...
```

These will NEVER match because `/(.*)" catches everything first. You need to either:
- Remove the catch-all (only keep specific routes)
- OR flip the order (specific routes first, catch-all last) ← **Correct approach**

#### 🟡 **`maxDuration` Scope**
Current config:
```json
"functions": { "api/**/*.ts": { "maxDuration": 800 } }
```

After consolidation:
```json
"functions": { "api/index.ts": { "maxDuration": 800 } }
```

**Question:** Does this still apply the 800s timeout to ALL routes handled by that function, or does Vercel need explicit path-based config? The glob pattern `api/**/*.ts` previously matched 9 files, each getting 800s. Now it's one file. **This should work**, but verify in testing.

#### 🟢 **CRON_SECRET Still Works**
Both cron handlers check `Authorization: Bearer ${CRON_SECRET}` (heartbeat.ts:79, consolidate.ts:19). This auth check will still work regardless of how the request is routed. ✅

---

## 3. Vercel-Specific Gotchas

### **Do Cron Paths Resolve via Rewrites?** ← THE critical question

I searched extensively for:
- Official Vercel docs on cron + rewrite interaction
- Real-world examples of single-function + cron via rewrites
- GitHub issues, Stack Overflow, Reddit discussions

**Finding:** No definitive answer. The docs are ambiguous.

**Recommended verification approach:**
1. Deploy to a preview branch with a test cron job (schedule: `* * * * *` for every minute)
2. Delete the function file, add rewrite
3. Monitor logs for 5 minutes: does the cron succeed or 404?
4. **DO NOT deploy to production until this is verified**

### **Trailing Slashes**
Vercel docs warn: if your framework has `trailingSlash: true`, cron paths need trailing slashes to avoid 301 redirects (which cron jobs don't follow).

**Current setup:** Hono doesn't enforce trailing slashes, so this isn't an issue. ✅

### **Cron Only Runs in Production**
You can't test this in `vercel dev` or preview deployments with the "Visit Preview" button. You MUST:
- Deploy to production (or a production-equivalent branch)
- Wait for the cron schedule to trigger
- Check logs: `npx vercel logs <deployment-url> --scope realadvisor`

---

## 4. Alternative Approaches

### **Option A: Keep One Function File Per Cron Job**
**Why:** Eliminate all cron-related risk.

**Trade-off:**
- Still consolidate Slack/OAuth/webhook routes (biggest duplication)
- Keep `api/cron/heartbeat.ts` and `api/cron/consolidate.ts` as separate function files
- **Result:** 3 functions instead of 9 (60% reduction)
- Build time still improves significantly
- Zero risk of cron failure

**Config:**
```json
{
  "functions": {
    "api/**/*.ts": { "maxDuration": 800 }
  },
  "rewrites": [
    { "source": "/api/slack/:path*", "destination": "/api/index" },
    { "source": "/api/oauth/:path*", "destination": "/api/index" },
    { "source": "/api/webhook/:path*", "destination": "/api/index" },
    { "source": "/health", "destination": "/api/index" },
    { "source": "/(.*)", "destination": "/api/index" }
  ],
  "crons": [
    { "path": "/api/cron/consolidate", "schedule": "0 4 * * *" },
    { "path": "/api/cron/heartbeat", "schedule": "*/30 * * * *" }
  ]
}
```

**Files to keep:**
- `api/index.ts` (main entry point)
- `api/cron/consolidate.ts` (direct file, no rewrite)
- `api/cron/heartbeat.ts` (direct file, no rewrite)

**Files to delete:**
- `api/health.ts`
- `api/slack/events.ts`
- `api/slack/interactions.ts`
- `api/oauth/google/auth-url.ts`
- `api/oauth/google/callback.ts`
- `api/webhook/cursor-agent.ts`

### **Option B: Use Vercel's Build Output API**
Instead of file-based routing, use the `.vercel/output` structure to define functions programmatically. This gives explicit control over routing and might make the cron behavior clearer.

**Why:** More control, but significantly more complex. Not recommended unless you hit other limitations.

### **Option C: Test in Staging First** ← **RECOMMENDED**
Before doing anything:
1. Create a test cron job that runs every minute
2. Deploy the full proposed change to a staging/test deployment
3. Monitor for 10 minutes: do the cron jobs succeed?
4. **If yes:** Roll out to production
5. **If no:** Fall back to Option A

---

## 5. Implementation Details

### **Correct Rewrite Order**
The rewrites MUST be ordered **specific-to-general**:

```json
{
  "rewrites": [
    { "source": "/health", "destination": "/api/index" },
    { "source": "/api/cron/:path*", "destination": "/api/index" },
    { "source": "/api/slack/:path*", "destination": "/api/index" },
    { "source": "/api/oauth/:path*", "destination": "/api/index" },
    { "source": "/api/webhook/:path*", "destination": "/api/index" },
    { "source": "/(.*)", "destination": "/api/index" }
  ]
}
```

**Why:** Vercel processes rewrites top-to-bottom, first match wins. The catch-all `/(.*)" must be LAST.

**Note:** The specific `/api/*` rules are technically redundant (the catch-all covers them), but keeping them makes intent explicit and improves debuggability.

### **Rewrite Parameters**
The `:path*` parameter in `/api/cron/:path*` captures the rest of the path, but **Hono doesn't need it**. Hono routes based on the original request path (before the rewrite), so:
- Request: `GET /api/cron/heartbeat`
- Rewrite: `/api/index` (invokes that function)
- Hono receives: `GET /api/cron/heartbeat` (original path)
- Hono matches: `.get("/api/cron/heartbeat", ...)`

This means the rewrite is purely for Vercel's function routing, not Hono's internal routing. ✅

### **HTTP Methods**
Current function files export different methods:
- `api/index.ts`: `GET`, `POST`
- `api/health.ts`: `GET`
- `api/cron/heartbeat.ts`: `GET`
- `api/slack/events.ts`: `GET`, `POST`
- etc.

**After consolidation:**
`api/index.ts` must export ALL methods used by any route:

```typescript
import { handle } from "hono/vercel";
import app from "../src/app.js";

export const GET = handle(app);
export const POST = handle(app);
```

**Current `api/index.ts` already exports both.** ✅

**Question:** Are there any `PUT`, `PATCH`, or `DELETE` routes? 
- Checked `src/app.ts` — all routes use `.get()` or `.post()`
- No `PUT`/`PATCH`/`DELETE` handlers found ✅

### **Functions Config**
Change from glob to specific file:

```json
{
  "functions": {
    "api/index.ts": {
      "maxDuration": 800
    }
  }
}
```

**Caveat:** If you keep Option A (separate cron files), use:

```json
{
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 800
    }
  }
}
```

This applies 800s to all functions (including the cron files).

---

## 6. Cold Start Implications

### **Current State: 9 Independent Pools**
- Each function file creates a separate serverless function
- Each function has its own cold start pool
- Low-traffic routes (e.g., `/api/oauth/google/callback`) cold start on EVERY request
- High-traffic routes (e.g., `/api/slack/events`) stay warm

**Cold start frequency:**
- Slack events: ~every 10-30 min (frequent traffic)
- Cron heartbeat: every 30 min (moderate traffic)
- OAuth callbacks: ~once per day or less (cold starts on every use)

### **After Consolidation: 1 Shared Pool**

**Positive effects:**
- All routes share the same warm instance pool
- Low-traffic routes benefit from high-traffic routes keeping the pool warm
- **Likely improvement** for OAuth callbacks, health checks, cursor-agent webhook
- Total cold start count decreases (fewer independent pools to warm)

**Negative effects:**
- If NO traffic for ~5-15 minutes, the single pool goes cold
- Then ALL routes cold start together (vs. before, where only that specific route cold started)
- **Unlikely to be an issue** given:
  - Cron heartbeat runs every 30 min (keeps pool semi-warm)
  - Slack traffic is frequent during work hours

### **Cold Start Latency**
- Cold start time is dominated by:
  1. Loading dependencies (~28k-line Hono app + `node_modules`)
  2. Initializing connections (Slack client, DB client)
  3. Running top-level imports

**Current:** Each function loads the same code independently (9x redundant cold starts total)  
**After:** One function loads once, serves all routes (1x cold start, shared by all)

**Net effect:** Total cold start time across all routes decreases, but individual route latency might spike if cold (same spike as before, just less frequent).

### **Monitoring Cold Starts**
After deploy, monitor:
- Vercel function logs: `x-vercel-cache: MISS` indicates cold start
- Response time p95/p99 metrics
- Slack event processing latency (3-second ACK window)

**Risk:** If the consolidated function is too large (>50MB or long init time), Vercel might deprioritize keeping it warm. The current bundle is probably <10MB (no indication of bloat), so this should be fine. ✅

---

## 7. Testing Plan

### **Pre-Deploy Checklist**
1. ✅ TypeScript compiles (`npm run typecheck`)
2. ✅ Verify all routes in `src/app.ts` use only `GET` or `POST` methods
3. ⚠️ **Critical:** Test cron + rewrite behavior (see below)
4. ✅ Verify `CRON_SECRET` is set in production env vars
5. ✅ Review Vercel logs for current cron job success rate (baseline)

### **Cron Verification (CRITICAL)**
**DO THIS BEFORE FULL ROLLOUT:**

1. Create a test branch: `test/single-function-cron`
2. Add a test cron job with a frequent schedule:
   ```json
   {
     "crons": [
       {
         "path": "/api/cron/heartbeat",
         "schedule": "* * * * *"  // Every minute
       }
     ]
   }
   ```
3. Deploy to production (cron only runs in prod, not preview)
4. Monitor logs for 10 minutes:
   ```bash
   npx vercel logs <deployment-url> --scope realadvisor --follow
   ```
5. **Expected:** 10 successful 200 responses from `/api/cron/heartbeat`
6. **Failure mode:** 10x 404 responses → rewrites don't apply to cron paths
7. If 404s occur, **ABORT** and fall back to Option A (keep cron files separate)

### **Post-Deploy Monitoring (First 24 Hours)**
- [ ] Verify cron jobs run successfully:
  - `heartbeat`: Check logs every 30 min
  - `consolidate`: Check logs at 4:00 AM UTC next day
- [ ] Monitor Slack event processing latency (no degradation)
- [ ] Check for any 404s or routing errors in Vercel logs
- [ ] Verify OAuth callbacks still work (trigger a Google auth flow)
- [ ] Check Cursor webhook delivery (trigger a Cursor agent run)

### **Rollback Plan**
If anything breaks:
1. Revert the PR immediately
2. Redeploy previous version (Vercel keeps old deployments, can instant-rollback)
3. Investigate logs to determine failure mode
4. If cron-related: switch to Option A
5. If routing-related: check rewrite order

---

## 8. Recommendations

### **Immediate Action: Verify Cron Behavior**
Before implementing the full proposal:

1. **Test in isolation:**
   - Create a minimal reproduction: 1 function file (`api/test.ts`), 1 rewrite, 1 cron
   - Deploy to production
   - Observe whether the cron invocation resolves via the rewrite
   - **This is the ONLY way to know for sure**

2. **If cron + rewrite works:** Proceed with full consolidation
3. **If cron + rewrite fails:** Use Option A (keep cron files separate)

### **Conservative Approach (Recommended for Production)**
Given the uncertainty, I recommend **Option A**:
- Consolidate everything EXCEPT cron job files
- Result: 3 functions instead of 9 (still 66% reduction)
- Build time still improves significantly (~20-40s savings)
- **Zero risk** of cron failure
- Can revisit full consolidation later once cron + rewrite behavior is confirmed

**Files to keep:**
```
api/index.ts              (main entry point)
api/cron/consolidate.ts   (direct file)
api/cron/heartbeat.ts     (direct file)
```

**Files to delete:**
```
api/health.ts
api/slack/events.ts
api/slack/interactions.ts
api/oauth/google/auth-url.ts
api/oauth/google/callback.ts
api/webhook/cursor-agent.ts
```

**Config:**
```json
{
  "functions": {
    "api/**/*.ts": { "maxDuration": 800 }
  },
  "rewrites": [
    { "source": "/health", "destination": "/api/index" },
    { "source": "/api/slack/:path*", "destination": "/api/index" },
    { "source": "/api/oauth/:path*", "destination": "/api/index" },
    { "source": "/api/webhook/:path*", "destination": "/api/index" },
    { "source": "/(.*)", "destination": "/api/index" }
  ],
  "crons": [
    { "path": "/api/cron/consolidate", "schedule": "0 4 * * *" },
    { "path": "/api/cron/heartbeat", "schedule": "*/30 * * * *" }
  ]
}
```

### **Aggressive Approach (Full Consolidation)**
If you want to go all-in on the original proposal:

**Prerequisites:**
1. ✅ Test cron + rewrite behavior FIRST (as described above)
2. ✅ Set up monitoring for cron job failures
3. ✅ Have a rollback plan ready
4. ✅ Deploy during low-traffic hours

**Implementation:**
- Delete all 8 wrapper files
- Update `vercel.json` with rewrites (fix the order!)
- Update functions config to `api/index.ts` specifically
- Monitor closely for 24 hours

---

## 9. Edge Cases

### **What if a cron job times out?**
Both cron jobs have `maxDuration: 800` (13.3 minutes). After consolidation:
- The single function has the same timeout
- Timeout behavior is unchanged ✅

### **What if Hono routing changes?**
The consolidation assumes Hono handles routing internally. If you ever:
- Remove a route from `src/app.ts`
- Change route paths
- Add authentication middleware

**Impact:** None! Hono routing is independent of Vercel function routing. The rewrites just ensure all requests hit the same function; Hono handles the rest. ✅

### **What if you add a new route?**
**Before consolidation:** Create a new file `api/new-route.ts`  
**After consolidation:** Just add the route to `src/app.ts`

The catch-all rewrite `/(.*)" → `/api/index` ensures all new routes automatically work. ✅

### **What about Vercel's function size limit?**
- Free/Hobby: 50 MB per function
- Pro: 50 MB per function (250 MB with config)
- Enterprise: 250 MB per function

**Current bundle size:** Likely <10 MB (typical for a Hono app with these dependencies)  
**After consolidation:** Same size, just 1 bundle instead of 9  
**Risk:** None ✅

---

## 10. Final Verdict

### **Feasibility:** ⚠️ **UNVERIFIED** for cron jobs, ✅ **PROVEN** for HTTP routes

### **Recommendation:**
1. **DO NOT deploy the full proposal blindly**
2. **FIRST:** Verify cron + rewrite behavior with a test deployment
3. **If verified:** Proceed with full consolidation
4. **If not verified:** Use Option A (conservative approach)

### **Expected Impact (if successful):**
- ✅ Build time: ~30-60s faster
- ✅ Deploy size: ~8x smaller (fewer bundles)
- ✅ Cold starts: Likely improved for low-traffic routes
- ✅ Maintainability: Simpler (no redundant wrapper files)

### **Risk Rating:**
- **If cron + rewrite works:** 🟢 Low risk (mostly upside)
- **If cron + rewrite fails:** 🔴 **High risk** (silent cron failures, data loss)

### **Confidence Level:**
- HTTP routing via rewrites: **100% confident**
- Cron routing via rewrites: **30% confident** (ambiguous docs, no examples found)

---

## Questions for @wieseljonas

1. **Have you tested cron + rewrite behavior before?** Any prior experience with this pattern?
2. **Is there existing cron monitoring?** (Datadog, Sentry, etc.) to catch silent failures?
3. **How critical are the cron jobs?** 
   - `heartbeat`: Runs every 30 min, executes pending jobs, recovers stale jobs
   - `consolidate`: Runs daily at 4 AM, consolidates memory + profiles
   - **If these fail silently, what's the blast radius?**
4. **Preference:** Full consolidation (higher reward, higher risk) or conservative approach (lower reward, zero risk)?

---

**Author:** AI Review (Claude Sonnet 4.5)  
**Date:** 2026-03-09  
**Issue:** #13 — perf: consolidate 9 serverless functions into 1 entry point
