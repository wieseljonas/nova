export const OAUTH_RETURN_TO_COOKIE = "oauth_return_to";

export function getSafeReturnTo(returnTo: string | null | undefined) {
  if (!returnTo || !returnTo.startsWith("/")) {
    return null;
  }

  // Reject protocol-relative URLs like //evil.com.
  if (returnTo.startsWith("//")) {
    return null;
  }

  if (returnTo.startsWith("/api/auth")) {
    return null;
  }

  return returnTo;
}

export function buildAppRedirectUrl(
  appUrl: string,
  returnTo: string | null | undefined,
) {
  return new URL(getSafeReturnTo(returnTo) || "/", appUrl);
}
