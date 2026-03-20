import * as nodePath from "node:path";

export const RECIPE_ROOT_PREFIX = "/mnt/gcs/recipes";

/**
 * Normalize and validate a recipe root path.
 * Enforces that all recipe roots live under /mnt/gcs/recipes/.
 */
export function resolveRecipeRoot(
  jobName: string,
  recipeRoot?: string | null,
): string {
  const raw = (recipeRoot && recipeRoot.trim().length > 0)
    ? recipeRoot.trim()
    : `${RECIPE_ROOT_PREFIX}/${jobName}`;
  const normalized = nodePath.posix.normalize(raw).replace(/\/+$/, "");

  if (!normalized.startsWith(`${RECIPE_ROOT_PREFIX}/`)) {
    throw new Error(
      `Invalid recipe_root. Must be inside ${RECIPE_ROOT_PREFIX}/`,
    );
  }

  // Keep path constraints tight to avoid shell/path surprises.
  if (!/^\/[A-Za-z0-9/_-]+$/.test(normalized)) {
    throw new Error(
      "Invalid recipe_root. Only letters, numbers, /, _, and - are allowed.",
    );
  }

  return normalized;
}

export function clampRecipeTimeoutSeconds(
  timeoutSeconds: number | null | undefined,
): number {
  const value = timeoutSeconds ?? 600;
  if (value < 10) return 10;
  if (value > 750) return 750;
  return value;
}

