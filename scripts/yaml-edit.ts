/**
 * yaml-surgery.ts
 *
 * Surgical line-level editing of EVE overview YAML files.
 * Modifies only group ID lines; everything else is preserved byte-for-byte.
 *
 * EVE YAML groups list structure (where N = indent of the "- - groups" line):
 *
 *   {N spaces}- - groups           <- groups header
 *   {N+2 spaces}- - {firstId}      <- first item (or "- []" if empty)
 *   {N+4 spaces}- {id}             <- subsequent items
 *
 * Preset name lines (always at column 0):
 *   - - 'preset name'
 *   - - "preset name"
 *   - - preset name (unquoted)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Strip EVE color tags for matching purposes. */
export function stripColorTags(s: string): string {
  return s.replace(/<color=[^>]+>/gi, "").replace(/<\/color>/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface Line {
  content: string; // without \r
  eol: string;     // "\r\n", "\n", or "" (last line)
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  const parts = raw.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (part.endsWith("\r")) {
      lines.push({ content: part.slice(0, -1), eol: isLast ? "\r" : "\r\n" });
    } else {
      lines.push({ content: part, eol: isLast ? "" : "\n" });
    }
  }
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((l) => l.content + l.eol).join("");
}

/** Parse the preset name from a `- - 'name'` or `- - "name"` or `- - name` line. */
function parsePresetName(content: string): string | null {
  const m = content.match(/^- - (.+)$/);
  if (!m) return null;
  const val = m[1].trim();
  // Strip surrounding quotes if present
  if ((val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))) {
    return val.slice(1, -1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove a set of group IDs from every groups list in the file.
 * Operates purely on raw text — no YAML parse/dump involved.
 */
export function removeGroupIds(raw: string, idsToRemove: Set<number>): { result: string; changed: boolean } {
  if (idsToRemove.size === 0) return { result: raw, changed: false };

  const lines = splitLines(raw);
  const out: Line[] = [];
  let changed = false;
  let i = 0;

  while (i < lines.length) {
    const { content, eol } = lines[i];

    // Match both "- - groups" and "- - - groups" (used by default* presets)
    const headerMatch = content.match(/^(\s*)- - groups$/) ?? content.match(/^(\s*)- - - groups$/);
    if (!headerMatch) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // Found a groups header — emit it as-is
    out.push(lines[i]);
    i++;

    // For "- - - groups" (3-dash), IDs are indented 2 more spaces than the header
    const headerDashes = content.trimStart().startsWith("- - - ") ? 3 : 2;
    const N = headerMatch[1].length + (headerDashes === 3 ? 2 : 0);
    const firstPrefix = " ".repeat(N + 2) + "- - ";
    const subPrefix = " ".repeat(N + 4) + "- ";
    const emptyContent = " ".repeat(N + 2) + "- []";

    // Peek at next line
    if (i >= lines.length) continue;
    const nextContent = lines[i].content;

    // Empty list — nothing to do
    if (nextContent === emptyContent) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // Collect consecutive group ID lines
    const collected: Line[] = [];
    while (i < lines.length) {
      const lc = lines[i].content;
      if (lc.startsWith(firstPrefix) && /^\d+$/.test(lc.slice(firstPrefix.length)) ||
          lc.startsWith(subPrefix) && /^\d+$/.test(lc.slice(subPrefix.length))) {
        collected.push(lines[i]);
        i++;
      } else {
        break;
      }
    }

    // Parse IDs
    const ids: number[] = collected.map((l) => {
      const lc = l.content;
      return parseInt(
        lc.startsWith(firstPrefix) ? lc.slice(firstPrefix.length) : lc.slice(subPrefix.length),
        10
      );
    });

    const filtered = ids.filter((id) => !idsToRemove.has(id));

    if (filtered.length === ids.length) {
      // No removals in this block — emit as-is
      out.push(...collected);
      continue;
    }

    changed = true;
    const lineEol = collected[0]?.eol ?? eol;

    if (filtered.length === 0) {
      out.push({ content: emptyContent, eol: lineEol });
    } else {
      out.push({ content: firstPrefix + filtered[0], eol: lineEol });
      for (const id of filtered.slice(1)) {
        out.push({ content: subPrefix + id, eol: lineEol });
      }
    }
  }

  return { result: joinLines(out), changed };
}

/**
 * Add a group ID to every groups list whose preset matches the predicate.
 * IDs are inserted in sorted ascending order.
 * Operates purely on raw text.
 */
export function addGroupId(
  raw: string,
  groupId: number,
  presetMatcher: (presetName: string) => boolean
): { result: string; addedToPresets: string[] } {
  const lines = splitLines(raw);
  const out: Line[] = [];
  const addedToPresets: string[] = [];
  let i = 0;
  let currentPresetName: string | null = null;

  while (i < lines.length) {
    const { content, eol } = lines[i];

    // Detect preset name lines (at column 0)
    if (content.startsWith("- - ")) {
      const name = parsePresetName(content);
      if (name !== null) currentPresetName = name;
    }

    const headerMatch = content.match(/^(\s*)- - groups$/) ?? content.match(/^(\s*)- - - groups$/);
    if (!headerMatch || currentPresetName === null || !presetMatcher(currentPresetName)) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // Found a matching groups section — emit the header
    out.push(lines[i]);
    i++;

    const headerDashes = content.trimStart().startsWith("- - - ") ? 3 : 2;
    const N = headerMatch[1].length + (headerDashes === 3 ? 2 : 0);
    const firstPrefix = " ".repeat(N + 2) + "- - ";
    const subPrefix = " ".repeat(N + 4) + "- ";
    const emptyContent = " ".repeat(N + 2) + "- []";

    if (i >= lines.length) continue;
    const nextContent = lines[i].content;

    // Determine EOL to use for new lines (match existing)
    const lineEol = lines[i].eol;

    if (nextContent === emptyContent) {
      // Was empty — replace with single item
      i++; // consume the "- []" line
      out.push({ content: firstPrefix + groupId, eol: lineEol });
      addedToPresets.push(currentPresetName);
      continue;
    }

    // Collect existing items
    const collected: Line[] = [];
    while (i < lines.length) {
      const lc = lines[i].content;
      if (lc.startsWith(firstPrefix) && /^\d+$/.test(lc.slice(firstPrefix.length)) ||
          lc.startsWith(subPrefix) && /^\d+$/.test(lc.slice(subPrefix.length))) {
        collected.push(lines[i]);
        i++;
      } else {
        break;
      }
    }

    const ids: number[] = collected.map((l) => {
      const lc = l.content;
      return parseInt(
        lc.startsWith(firstPrefix) ? lc.slice(firstPrefix.length) : lc.slice(subPrefix.length),
        10
      );
    });

    // Already present — emit unchanged
    if (ids.includes(groupId)) {
      out.push(...collected);
      continue;
    }

    // Insert in sorted order
    const merged = [...ids, groupId].sort((a, b) => a - b);
    out.push({ content: firstPrefix + merged[0], eol: lineEol });
    for (const id of merged.slice(1)) {
      out.push({ content: subPrefix + id, eol: lineEol });
    }
    addedToPresets.push(currentPresetName);
  }

  return { result: joinLines(out), addedToPresets };
}
