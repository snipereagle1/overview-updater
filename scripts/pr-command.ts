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
import yaml from "js-yaml"; // still needed for extractPresetInfo
import { Octokit } from "@octokit/rest";
import { fetchCurrentBuildNumber, loadGroupsMap, type Group } from "./sde-client";
import { addGroupId, stripColorTags } from "./yaml-edit";

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
// YAML helpers (parse only — writing is done surgically)
// ---------------------------------------------------------------------------

interface PresetInfo {
  name: string;
  groupIds: number[];
}

function extractPresetInfo(doc: YamlValue): PresetInfo[] {
  const infos: PresetInfo[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return infos;
  const obj = doc as { [k: string]: YamlValue };
  const presets = obj["presets"];
  if (!Array.isArray(presets)) return infos;

  for (const presetEntry of presets) {
    if (!Array.isArray(presetEntry) || presetEntry.length < 2) continue;
    const name = String(presetEntry[0]);
    const presetData = presetEntry[1];
    if (!Array.isArray(presetData)) continue;

    const groupIds: number[] = [];
    for (const kv of presetData) {
      if (!Array.isArray(kv) || kv.length < 2) continue;
      if (kv[0] === "groups" && Array.isArray(kv[1])) {
        for (const id of kv[1]) {
          if (typeof id === "number") groupIds.push(id);
        }
      }
    }
    infos.push({ name, groupIds });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Apply a single command across all overview files
// ---------------------------------------------------------------------------

interface OverviewFile {
  filePath: string;
  fileName: string;
  raw: string;
  presets: PresetInfo[];
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
    // Build a matcher for this command based on the parsed preset info
    const matchingPresetNames = new Set<string>();
    for (const preset of file.presets) {
      let shouldAdd = false;
      if (cmd.mode.type === "to-preset") {
        const strippedName = stripColorTags(preset.name).toLowerCase();
        shouldAdd = strippedName.includes(cmd.mode.pattern.toLowerCase());
      } else if (cmd.mode.type === "like") {
        shouldAdd = preset.groupIds.includes(cmd.mode.likeId);
      } else if (cmd.mode.type === "to-category") {
        const targetCategoryId = cmd.mode.categoryId;
        shouldAdd = preset.groupIds.some((id) => groupsMap.get(id)?.categoryID === targetCategoryId);
      }
      if (shouldAdd) matchingPresetNames.add(preset.name);
    }

    if (matchingPresetNames.size === 0) continue;

    // Apply surgically
    const { result, addedToPresets } = addGroupId(
      file.raw,
      cmd.groupId,
      (presetName) => matchingPresetNames.has(presetName)
    );

    if (addedToPresets.length > 0) {
      file.raw = result; // update for subsequent commands on the same file
      changes.push({ file: file.fileName, presets: addedToPresets });
    }
  }

  if (changes.length === 0) {
    return { command: cmd, groupName, changes, error: `No matching presets found — group was not added anywhere` };
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
      const raw = fs.readFileSync(filePath, "utf8");
      const doc = yaml.load(raw) as YamlValue;
      return { filePath, fileName: f, raw, presets: extractPresetInfo(doc) };
    });

  if (overviewFiles.length === 0) {
    console.warn("No overview YAML files found.");
    process.exit(0);
  }

  // Apply commands (each command updates file.raw in-place for chaining)
  const originalRaws = new Map(overviewFiles.map((f) => [f.fileName, f.raw]));
  const results: ApplyResult[] = [];
  for (const cmd of commands) {
    console.log(`Applying: ${cmd.raw}`);
    results.push(applyCommand(cmd, overviewFiles, groupsMap));
  }

  // Write files whose raw content changed
  for (const file of overviewFiles) {
    if (file.raw !== originalRaws.get(file.fileName)) {
      fs.writeFileSync(file.filePath, file.raw, "utf8");
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
