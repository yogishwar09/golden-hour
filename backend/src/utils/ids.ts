import { Types } from 'mongoose';

/**
 * The id of a reference field, whether or not the query populated it.
 *
 * A populated path holds a document, not an ObjectId, and calling `toString()`
 * on a document yields its inspected form rather than its id -- so a comparison
 * that looks right silently never matches. Every reference comparison goes
 * through this.
 */
export function toId(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === 'string') return value;

  const candidate = (value as { _id?: unknown })._id;
  if (candidate instanceof Types.ObjectId) return candidate.toString();
  if (typeof candidate === 'string') return candidate;

  return null;
}

/** True when two reference fields point at the same document. */
export function sameId(a: unknown, b: unknown): boolean {
  const left = toId(a);
  const right = toId(b);
  return left !== null && left === right;
}
