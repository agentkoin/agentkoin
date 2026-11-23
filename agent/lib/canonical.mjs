import canonicalize from "canonicalize";
import { keccak256, toBytes, sha256 } from "viem";

/** RFC 8785 (JCS) canonical JSON string. */
export const jcs = (obj) => canonicalize(obj);

/** Return a copy without the given top-level keys (used to exclude signature fields before hashing). */
export function omit(obj, keys) {
  const o = { ...obj };
  for (const k of keys) delete o[k];
  return o;
}

export const keccakJcs = (obj) => keccak256(toBytes(jcs(obj)));
export const sha256Hex = (strOrBytes) => sha256(typeof strOrBytes === "string" ? toBytes(strOrBytes) : strOrBytes);
