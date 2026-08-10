import { isAbsolute, relative, sep } from "node:path";

export { canonical, sha256 } from "@smartflow/protocol";

/**
 * Returns `true` when `target` is strictly inside `root`
 * (i.e. `target` is a descendant but NOT equal to `root`).
 */
export function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Returns `true` when `target` is inside or equal to `root`.
 */
export function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length === 0 || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
