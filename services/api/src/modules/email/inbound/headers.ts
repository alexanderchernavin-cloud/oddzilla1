// Header parsing for SendGrid Inbound Parse payloads.
//
// SendGrid delivers the raw header block as a single multi-line
// string in the `headers` field. RFC 5322 header values can fold
// across continuation lines (next line starts with whitespace);
// the parser below joins them back into a single line per header.

export interface ParsedHeaders {
  /** Case-insensitive header name → most-recent value. */
  get(name: string): string | null;
}

export function parseHeaders(raw: string): ParsedHeaders {
  const map = new Map<string, string>();
  if (!raw) {
    return { get: (n) => map.get(n.toLowerCase()) ?? null };
  }
  const lines = raw.split(/\r?\n/);
  let currentName: string | null = null;
  let currentValue: string[] = [];

  const flush = () => {
    if (currentName !== null) {
      // Last-wins on duplicate header names is what most parsers do
      // and matches the "most relevant" header for our threading needs.
      map.set(currentName.toLowerCase(), currentValue.join(" ").trim());
    }
    currentName = null;
    currentValue = [];
  };

  for (const line of lines) {
    if (line.length === 0) {
      // Body separator — stop processing.
      flush();
      break;
    }
    if (/^[ \t]/.test(line)) {
      // Continuation of the previous header.
      if (currentName !== null) currentValue.push(line.trim());
      continue;
    }
    flush();
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    currentName = line.slice(0, idx).trim();
    currentValue = [line.slice(idx + 1).trim()];
  }
  flush();

  return {
    get(name: string): string | null {
      return map.get(name.toLowerCase()) ?? null;
    },
  };
}

/** Pulls "Display Name" <addr@host> apart. Returns address (lowercased)
 * + optional display name. Returns null when the input is empty.
 * Tolerates the bare-address form `addr@host`. */
export function parseAddress(raw: string | null | undefined): {
  address: string;
  name: string | null;
} | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1]!.replace(/^"|"$/g, "").trim() || null;
    return { address: angle[2]!.trim().toLowerCase(), name };
  }
  return { address: trimmed.toLowerCase(), name: null };
}
