/**
 * validate.ts
 *
 * CI validation pass: parse all overviews/*.yaml, collect every group ID,
 * cross-reference against the live SDE groups.jsonl, and fail if any
 * group ID is completely absent (published: false is allowed — many
 * valid celestials like Sun/Stargate/Station are unpublished in the market sense).
 *
 * This catches hand-edit mistakes before they can be merged to main.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { fetchCurrentBuildNumber, loadGroupsMap } from "./sde-client";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERVIEWS_DIR = path.join(REPO_ROOT, "overviews");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

// ---------------------------------------------------------------------------
// Extract group IDs from a YAML doc
// ---------------------------------------------------------------------------

function extractGroupIds(doc: YamlValue): number[] {
  const ids: number[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ids;

  const obj = doc as { [k: string]: YamlValue };
  const presets = obj["presets"];
  if (!Array.isArray(presets)) return ids;

  for (const presetEntry of presets) {
    if (!Array.isArray(presetEntry) || presetEntry.length < 2) continue;
    const presetData = presetEntry[1];
    if (!Array.isArray(presetData)) continue;

    for (const kv of presetData) {
      if (!Array.isArray(kv) || kv.length < 2) continue;
      if (kv[0] === "groups" && Array.isArray(kv[1])) {
        for (const id of kv[1]) {
          if (typeof id === "number") ids.push(id);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const buildNumber = await fetchCurrentBuildNumber();
  const groupsMap = await loadGroupsMap(buildNumber);
  console.log(`Loaded ${groupsMap.size} groups from SDE`);

  const overviewFiles = fs
    .readdirSync(OVERVIEWS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(OVERVIEWS_DIR, f));

  if (overviewFiles.length === 0) {
    console.warn("No overview YAML files found — skipping validation");
    process.exit(0);
  }

  interface InvalidEntry {
    file: string;
    id: number;
    reason: string;
  }

  const invalid: InvalidEntry[] = [];

  for (const filePath of overviewFiles) {
    const fileName = path.basename(filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    let doc: YamlValue;
    try {
      doc = yaml.load(raw) as YamlValue;
    } catch (e) {
      console.error(`Failed to parse ${fileName}: ${e}`);
      process.exit(1);
    }

    const ids = extractGroupIds(doc);
    for (const id of ids) {
      if (!groupsMap.has(id)) {
        invalid.push({ file: fileName, id, reason: "not found in SDE" });
      }
    }
  }

  if (invalid.length === 0) {
    console.log("All group IDs are valid.");
    process.exit(0);
  }

  console.error("\nValidation FAILED — invalid group IDs detected:\n");
  console.error("File                       | Group ID | Reason");
  console.error("---------------------------|----------|-----------------------------");
  for (const entry of invalid) {
    console.error(
      `${entry.file.padEnd(26)} | ${String(entry.id).padEnd(8)} | ${entry.reason}`
    );
  }
  console.error(`\n${invalid.length} invalid group ID(s) found.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
