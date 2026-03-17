import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { verifyProxyToken } from "../lib/proxy-token.js";
import { injectCredentialAuth } from "../lib/credential-auth.js";
import { isPrivateUrl } from "../lib/ssrf.js";
import { getApiCredentialWithType, sanitizeHeaders } from "../lib/api-credentials.js";
import { db } from "../db/client.js";
import { credentialAuditLog } from "@aura/db/schema";

export const proxyApp = new Hono();

proxyApp.all("/:credentialKey{.+}", async (c) => {
  const credentialKey = c.req.param("credentialKey");
  if (!credentialKey) {
    return c.json({ ok: false, error: "Missing credential key" }, 400);
  }

  const authHeader = c.req.header("authorization") ?? "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return c.json({ ok: false, error: "Missing bearer token" }, 401);
  }

  let tokenPayload: { credentialKeys: string[]; userId: string; credentialOwner: string };
  try {
    tokenPayload = verifyProxyToken(tokenMatch[1]);
  } catch (error: any) {
    return c.json(
      { ok: false, error: error?.message || "Invalid proxy token" },
      401,
    );
  }

  if (!tokenPayload.credentialKeys.includes(credentialKey)) {
    return c.json({ ok: false, error: "Credential not allowed by token" }, 403);
  }

  // Primary: read target URL from header (immune to path normalization).
  // Fallback: extract from path for backwards compat.
  let targetUrl = c.req.header("x-target-url") ?? "";

  if (!targetUrl) {
    const pathPrefix = `/${credentialKey}/`;
    const pathIdx = c.req.path.indexOf(pathPrefix);
    targetUrl = pathIdx >= 0 ? c.req.path.slice(pathIdx + pathPrefix.length) : "";
    // Vercel 308 redirects collapse // to / in paths; reconstruct protocol.
    if (targetUrl) {
      targetUrl = targetUrl.replace(/^(https?:\/)([^/])/, "$1/$2");
    }
  }

  if (!targetUrl) {
    return c.json(
      { ok: false, error: "Missing target URL. Set X-Target-URL header or include URL in path." },
      400,
    );
  }

  const requestUrl = new URL(c.req.url);
  if (requestUrl.search) {
    targetUrl = targetUrl.includes("?")
      ? `${targetUrl}&${requestUrl.search.slice(1)}`
      : `${targetUrl}${requestUrl.search}`;
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    return c.json({ ok: false, error: "Target URL must start with http(s)://" }, 400);
  }

  if (await isPrivateUrl(targetUrl)) {
    return c.json(
      { ok: false, error: "Blocked: target URL resolves to a private/internal address" },
      403,
    );
  }

  const method = c.req.method.toUpperCase();
  const isWriteMethod = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const credential = await getApiCredentialWithType(
    credentialKey,
    tokenPayload.credentialOwner,
    tokenPayload.userId,
    isWriteMethod ? "write" : "read",
  );
  if (!credential) {
    return c.json(
      { ok: false, error: `Credential "${credentialKey}" not found or access denied` },
      404,
    );
  }

  const inboundHeaders = Object.fromEntries(c.req.raw.headers.entries());
  delete inboundHeaders.authorization;
  delete inboundHeaders.host;
  delete inboundHeaders["content-length"];
  delete inboundHeaders["x-target-url"];

  let forwardedUrl = targetUrl;
  let forwardedHeaders = inboundHeaders;
  try {
    const injected = injectCredentialAuth(targetUrl, inboundHeaders, {
      authScheme: credential.authScheme,
      value: credential.value,
    });
    forwardedUrl = injected.url;
    forwardedHeaders = injected.headers;
  } catch (error: any) {
    return c.json(
      { ok: false, error: error?.message || "Credential auth injection failed" },
      400,
    );
  }

  const body =
    method === "GET" || method === "HEAD" ? undefined : c.req.raw.body;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(forwardedUrl, {
      method,
      headers: forwardedHeaders,
      body,
      redirect: "manual",
    });
  } catch (error: any) {
    const errorMessage = error?.message || "Proxy request failed";
    waitUntil(
      db
        .insert(credentialAuditLog)
        .values({
          credentialId: credential.id,
          credentialName: credentialKey,
          accessedBy: tokenPayload.userId,
          action: "use",
          context: JSON.stringify({
            source: "proxy",
            request: {
              method,
              url: targetUrl,
              headers: sanitizeHeaders(inboundHeaders),
            },
            response: { error: errorMessage },
          }),
        })
        .catch(() => {}),
    );
    return c.json({ ok: false, error: errorMessage }, 502);
  }

  // Buffer the response instead of streaming -- Vercel's Node.js runtime
  // can return empty bodies when passing ReadableStream through new Response().
  const responseBody = await upstreamResponse.arrayBuffer();

  waitUntil(
    db
      .insert(credentialAuditLog)
      .values({
        credentialId: credential.id,
        credentialName: credentialKey,
        accessedBy: tokenPayload.userId,
        action: "use",
        context: JSON.stringify({
          source: "proxy",
          request: {
            method,
            url: targetUrl,
            headers: sanitizeHeaders(inboundHeaders),
          },
          response: {
            status: upstreamResponse.status,
            headers: sanitizeHeaders(
              Object.fromEntries(upstreamResponse.headers.entries()),
            ),
          },
        }),
      })
      .catch(() => {}),
  );

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("connection");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.delete("keep-alive");
  responseHeaders.delete("content-encoding");

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
});
