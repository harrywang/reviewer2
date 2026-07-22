/**
 * Model-id parsing — the single place that understands the "vendor/bare-id"
 * shape (e.g. "google/gemini-3-flash-preview"). Provider auto-detection, the
 * native-API prefix strip, and the price-table lookup all go through here so
 * they can never disagree.
 */

export interface ParsedModelId {
  /** The full id as given, e.g. "google/gemini-3-flash-preview". */
  full: string;
  /** The leading vendor segment, or null when the id has no "/". */
  vendor: string | null;
  /** The id minus its vendor prefix, e.g. "gemini-3-flash-preview". */
  bareId: string;
}

/**
 * Split a model id into { vendor, bareId }. The vendor is the first
 * "/"-delimited segment; bareId is everything after it. Ids without a slash
 * get vendor=null and bareId=full.
 */
export function parseModelId(id: string): ParsedModelId {
  const slash = id.indexOf("/");
  if (slash === -1) return { full: id, vendor: null, bareId: id };
  return { full: id, vendor: id.slice(0, slash), bareId: id.slice(slash + 1) };
}

/**
 * The id a native provider API expects: strips `prefix` (e.g. "anthropic/")
 * when present, otherwise returns the id unchanged (e.g. OpenRouter keeps the
 * full vendor-prefixed id).
 */
export function stripVendorPrefix(id: string, prefix: string | null): string {
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
