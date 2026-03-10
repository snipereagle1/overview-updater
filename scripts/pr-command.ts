/**
 * pr-command.ts
 *
 * Processes /add-group commands from PR comments and applies them to
 * overview YAML files.
 *
 * Supported syntaxes (multiple commands per comment are supported):
 *
 *   /add-group <id> to "<preset name pattern>"
 *     Add group to every preset whose name contains the pattern (case-insensitive,
 *     color codes stripped).
 *
 *   /add-group <id> like <existingId>
 *     Add group to every preset (across all files) that already contains <existingId>.
 *
 *   /add-group <id> to all-ships|all-npcs|all-entities|all-drones|all-deployables|all-structures
 *     Add group to every preset that contains at least one group from that SDE category.
 *
 * Environment variables (set by the workflow):
 *   COMMENT_BODY      — raw comment text
 *   GITHUB_REPOSITORY — owner/repo
 *   GITHUB_TOKEN      — for posting the reply comment
 *   PR_NUMBER         — PR number to comment on
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { Octokit } from "@octokit/rest";
import { fetchCurrentBuildNumber, loadGroupsMap, type Group } from "./sde-client.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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

type CommandMode =
  | { type: "to-preset"; pattern: string }
  | { type: "like"; likeId: number }
  | { type: "to-category"; categoryId: number; categoryLabel: string };

interface ParsedCommand {
  groupId: number;
  mode: CommandMode;
  raw: string;
}

interface ApplyResult {
  command: ParsedCommand;
  groupName: string;
  changes: { file: string; presets: string[] }[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Category alias map
// ---------------------------------------------------------------------------

const CATEGORY_ALIASES: Record<string, { id: number; label: string }> = {
  "all-ships":        { id: 6,  label: "Ship" },
  "all-npcs":         { id: 11, label: "Entity / NPC" },
  "all-entities":     { id: 11, label: "Entity / NPC" },
  "all-drones":       { id: 18, label: "Drone" },
  "all-deployables":  { id: 22, label: "Deployable" },
  "all-structures":   { id: 65, label: "Structure" },
};

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

function parseCommands(body: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];

  // Match each line that starts with /add-group
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/add-group")) continue;

    // /add-group <id> to "<pattern>"
    const toPresetMatch = trimmed.match(/^\/add-group\s+(\d+)\s+to\s+"([^"]+)"/i);
    if (toPresetMatch) {
      commands.push({
        groupId: parseInt(toPresetMatch[1], 10),
        mode: { type: "to-preset", pattern: toPresetMatch[2] },
        raw: trimmed,
      });
      continue;
    }

    // /add-group <id> like <existingId>
    const likeMatch = trimmed.match(/^\/add-group\s+(\d+)\s+like\s+(\d+)/i);
    if (likeMatch) {
      commands.push({
        groupId: parseInt(likeMatch[1], 10),
        mode: { type: "like", likeId: parseInt(likeMatch[2], 10) },
        raw: trimmed,
      });
      continue;
    }

    // /add-group <id> to all-<category>
    const toCategoryMatch = trimmed.match(/^\/add-group\s+(\d+)\s+to\s+(all-\w+)/i);
    if (toCategoryMatch) {
      const alias = toCategoryMatch[2].toLowerCase();
      const cat = CATEGORY_ALIASES[alias];
      if (cat) {
        commands.push({
          groupId: parseInt(toCategoryMatch[1], 10),
          mode: { type: "to-category", categoryId: cat.id, categoryLabel: cat.label },
          raw: trimmed,
        });
      } else {
        console.warn(`Unknown category alias: ${alias}. Valid: ${Object.keys(CATEGORY_ALIASES).join(", ")}`);
      }
      continue;
    }

    console.warn(`Could not parse command: ${trimmed}`);
  }

  return commands;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

/** Strip EVE color tags for matching: <color=0xFF...>text</color> → text */
function stripColorTags(s: string): string {
  return s.replace(/<color=[^>]+>/gi, "").replace(/<\/color>/gi, "").trim();
}

const YAML_DUMP_OPTIONS: yaml.DumpOptions = {
  indent: 2,
  lineWidth: -1,
  noRefs: true,
  flowLevel: -1,
  sortKeys: false,
  quotingType: "'",
  forceQuotes: false,
};

interface PresetRef {
  name: string;
  groupsList: YamlValue[]; // direct reference to the mutable groups array
}

/** Extract all presets with a direct reference to their groups array. */
function getPresetRefs(doc: YamlValue): PresetRef[] {
  const refs: PresetRef[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return refs;

  const obj = doc as { [k: string]: YamlValue };
  const presets = obj["presets"];
  if (!Array.isArray(presets)) return refs;

  for (const presetEntry of presets) {
    if (!Array.isArray(presetEntry) || presetEntry.length < 2) continue;
    const name = String(presetEntry[0]);
    const presetData = presetEntry[1];
    if (!Array.isArray(presetData)) continue;

    for (const kv of presetData) {
      if (!Array.isArray(kv) || kv.length < 2) continue;
      if (kv[0] === "groups" && Array.isArray(kv[1])) {
        refs.push({ name, groupsList: kv[1] as YamlValue[] });
      }
    }
  }
  return refs;
}

/** Add groupId to a preset's groups list if not already present. Returns true if added. */
function addToGroups(groupsList: YamlValue[], groupId: number): boolean {
  if (groupsList.includes(groupId)) return false;
  groupsList.push(groupId);
  // Keep sorted ascending for consistency
  groupsList.sort((a, b) => (a as number) - (b as number));
  return true;
}

// ---------------------------------------------------------------------------
// Apply a single command across all overview files
// ---------------------------------------------------------------------------

interface OverviewFile {
  filePath: string;
  fileName: string;
  doc: YamlValue;
  presets: PresetRef[];
}

function applyCommand(
  cmd: ParsedCommand,
  files: OverviewFile[],
  groupsMap: Map<number, Group>
): ApplyResult {
  const group = groupsMap.get(cmd.groupId);
  const groupName = group?.name?.en ?? `Group ${cmd.groupId}`;
  const changes: { file: string; presets: string[] }[] = [];

  if (!groupsMap.has(cmd.groupId)) {
    return { command: cmd, groupName, changes, error: `Group ${cmd.groupId} not found in SDE` };
  }

  for (const file of files) {
    const addedToPresets: string[] = [];

    for (const preset of file.presets) {
      let shouldAdd = false;

      if (cmd.mode.type === "to-preset") {
        const strippedName = stripColorTags(preset.name).toLowerCase();
        shouldAdd = strippedName.includes(cmd.mode.pattern.toLowerCase());
      } else if (cmd.mode.type === "like") {
        shouldAdd = preset.groupsList.includes(cmd.mode.likeId);
      } else if (cmd.mode.type === "to-category") {
        // Check if any group in this preset belongs to the target category
        const targetCategoryId = cmd.mode.categoryId;
        shouldAdd = (preset.groupsList as number[]).some((id) => {
          const g = groupsMap.get(id);
          return g?.categoryID === targetCategoryId;
        });
      }

      if (shouldAdd && addToGroups(preset.groupsList, cmd.groupId)) {
        addedToPresets.push(preset.name);
      }
    }

    if (addedToPresets.length > 0) {
      changes.push({ file: file.fileName, presets: addedToPresets });
    }
  }

  if (changes.length === 0) {
    return {
      command: cmd,
      groupName,
      changes,
      error: `No matching presets found — group was not added anywhere`,
    };
  }

  return { command: cmd, groupName, changes };
}

// ---------------------------------------------------------------------------
// Build reply comment
// ---------------------------------------------------------------------------

function buildReply(results: ApplyResult[]): string {
  const lines: string[] = [];
  lines.push("## /add-group results\n");

  for (const result of results) {
    const { command, groupName, changes, error } = result;
    lines.push(`### \`${command.raw}\``);
    lines.push("");

    if (error) {
      lines.push(`❌ **${groupName}** (ID: ${command.groupId}) — ${error}`);
    } else {
      const totalPresets = changes.reduce((sum, c) => sum + c.presets.length, 0);
      lines.push(`✅ **${groupName}** (ID: ${command.groupId}) added to **${totalPresets}** preset(s) across **${changes.length}** file(s):\n`);
      for (const change of changes) {
        lines.push(`**${change.file}**`);
        for (const preset of change.presets) {
          lines.push(`- ${preset}`);
        }
        lines.push("");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const commentBody = process.env.COMMENT_BODY;
  if (!commentBody) throw new Error("COMMENT_BODY env var not set");

  const prNumber = process.env.PR_NUMBER;
  if (!prNumber) throw new Error("PR_NUMBER env var not set");

  const repoStr = process.env.GITHUB_REPOSITORY;
  if (!repoStr) throw new Error("GITHUB_REPOSITORY env var not set");

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var not set");

  const [owner, repo] = repoStr.split("/");

  // Parse commands
  const commands = parseCommands(commentBody);
  if (commands.length === 0) {
    console.log("No valid /add-group commands found in comment.");
    process.exit(0);
  }
  console.log(`Found ${commands.length} command(s)`);

  // Load SDE
  const buildNumber = await fetchCurrentBuildNumber();
  const groupsMap = await loadGroupsMap(buildNumber);
  console.log(`Loaded ${groupsMap.size} groups from SDE`);

  // Load overview files
  const overviewFiles: OverviewFile[] = fs
    .readdirSync(OVERVIEWS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const filePath = path.join(OVERVIEWS_DIR, f);
      const doc = yaml.load(fs.readFileSync(filePath, "utf8")) as YamlValue;
      return { filePath, fileName: f, doc, presets: getPresetRefs(doc) };
    });

  if (overviewFiles.length === 0) {
    console.warn("No overview YAML files found.");
    process.exit(0);
  }

  // Apply commands
  const results: ApplyResult[] = [];
  for (const cmd of commands) {
    console.log(`Applying: ${cmd.raw}`);
    results.push(applyCommand(cmd, overviewFiles, groupsMap));
  }

  // Write modified files
  const modifiedFiles = new Set(
    results.flatMap((r) => r.changes.map((c) => c.file))
  );
  for (const file of overviewFiles) {
    if (modifiedFiles.has(file.fileName)) {
      const dumped = yaml.dump(file.doc, YAML_DUMP_OPTIONS);
      fs.writeFileSync(file.filePath, dumped, "utf8");
      console.log(`Wrote ${file.fileName}`);
    }
  }

  // Post reply comment
  const octokit = new Octokit({ auth: token });
  const reply = buildReply(results);

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: parseInt(prNumber, 10),
    body: reply,
  });

  console.log("Posted reply comment.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
