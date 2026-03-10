/**
 * check-sde.ts
 *
 * 1. Fetch the current SDE build number from the single-file URL.
 * 2. Compare against sde-state/sde-build.txt — exit early if unchanged.
 * 3. Download the full JSONL zip and extract groups.jsonl.
 * 4. Process all overviews/*.yaml files:
 *    a. Auto-strip stale (missing / unpublished) group IDs in-place.
 *    b. Collect new published groups in watched categories that aren't referenced.
 * 5. Update sde-state/sde-build.txt.
 * 6. Open a GitHub PR with a structured summary (skipped in --dry-run mode).
 *
 * Flags:
 *   --dry-run   Print results and PR body to stdout; do not write files or create a PR.
 *   --force     Ignore stored build number and always run the full check.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import yaml from "js-yaml";
import yauzl from "yauzl";
import { Octokit } from "@octokit/rest";
import { WATCHED_CATEGORY_IDS, WATCHED_CATEGORIES } from "./category-config.js";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

if (DRY_RUN) console.log("[dry-run] No files will be written and no PR will be created.\n");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SdeRecord {
  _key: string;
  buildNumber: number;
  [key: string]: unknown;
}

interface Group {
  _key: number;
  name: { en: string; [lang: string]: string };
  categoryID: number;
  published: boolean;
  [key: string]: unknown;
}

// EVE YAML preset structure (partial)
type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERVIEWS_DIR = path.join(REPO_ROOT, "overviews");
const SDE_STATE_FILE = path.join(REPO_ROOT, "sde-state", "sde-build.txt");
const GROUPS_CACHE_FILE = path.join(REPO_ROOT, "sde-state", "groups-cache.json");

const SDE_VERSION_URL =
  "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
const SDE_ZIP_URL =
  "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(res.headers.location));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchBuffer(res.headers.location));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// SDE version check
// ---------------------------------------------------------------------------

async function fetchCurrentBuildNumber(): Promise<number> {
  const text = await fetchText(SDE_VERSION_URL);
  const record = JSON.parse(text.trim()) as SdeRecord;
  return record.buildNumber;
}

function readStoredBuildNumber(): number | null {
  if (!fs.existsSync(SDE_STATE_FILE)) return null;
  const text = fs.readFileSync(SDE_STATE_FILE, "utf8").trim();
  const n = parseInt(text, 10);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Download & parse groups.jsonl from the zip
// ---------------------------------------------------------------------------

interface GroupsCache {
  buildNumber: number;
  groups: Group[];
}

function loadGroupsCache(buildNumber: number): Map<number, Group> | null {
  if (!fs.existsSync(GROUPS_CACHE_FILE)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(GROUPS_CACHE_FILE, "utf8")) as GroupsCache;
    if (cache.buildNumber !== buildNumber) return null;
    console.log(`Using cached groups for build ${buildNumber}`);
    return new Map(cache.groups.map((g) => [g._key, g]));
  } catch {
    return null;
  }
}

function saveGroupsCache(buildNumber: number, groups: Map<number, Group>): void {
  try {
    fs.mkdirSync(path.dirname(GROUPS_CACHE_FILE), { recursive: true });
    const cache: GroupsCache = { buildNumber, groups: [...groups.values()] };
    fs.writeFileSync(GROUPS_CACHE_FILE, JSON.stringify(cache), "utf8");
  } catch {
    // Non-fatal — cache is a local dev convenience, not required in CI
  }
}

async function downloadGroupsMap(buildNumber: number): Promise<Map<number, Group>> {
  const cached = loadGroupsCache(buildNumber);
  if (cached) return cached;

  console.log("Downloading SDE zip…");
  const zipBuffer = await fetchBuffer(SDE_ZIP_URL);
  console.log(`Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("No zipfile"));

      const groups = new Map<number, Group>();

      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith("groups.jsonl")) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error("No stream"));

          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const g = JSON.parse(trimmed) as Group;
                groups.set(g._key, g);
              } catch {
                // skip malformed lines
              }
            }
            saveGroupsCache(buildNumber, groups);
            resolve(groups);
          });
          stream.on("error", reject);
        });
      });

      zipfile.on("end", () => {
        if (groups.size === 0) {
          reject(new Error("groups.jsonl not found in SDE zip"));
        }
      });
      zipfile.on("error", reject);
    });
  });
}

// ---------------------------------------------------------------------------
// YAML processing helpers
// ---------------------------------------------------------------------------

interface PresetRef {
  presetName: string;
  groupIds: number[];
}

function extractPresets(doc: YamlValue): PresetRef[] {
  const refs: PresetRef[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return refs;

  const obj = doc as { [k: string]: YamlValue };
  const presets = obj["presets"];
  if (!Array.isArray(presets)) return refs;

  for (const presetEntry of presets) {
    if (!Array.isArray(presetEntry) || presetEntry.length < 2) continue;
    const presetName = String(presetEntry[0]);
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
    refs.push({ presetName, groupIds });
  }
  return refs;
}

function stripGroupIds(doc: YamlValue, idsToRemove: Set<number>): void {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  const obj = doc as { [k: string]: YamlValue };
  const presets = obj["presets"];
  if (!Array.isArray(presets)) return;

  for (const presetEntry of presets) {
    if (!Array.isArray(presetEntry) || presetEntry.length < 2) continue;
    const presetData = presetEntry[1];
    if (!Array.isArray(presetData)) continue;

    for (const kv of presetData) {
      if (!Array.isArray(kv) || kv.length < 2) continue;
      if (kv[0] === "groups" && Array.isArray(kv[1])) {
        const filtered = (kv[1] as number[]).filter((id) => !idsToRemove.has(id));
        kv[1] = filtered;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// YAML dump options that match EVE's expected format
// ---------------------------------------------------------------------------

const YAML_DUMP_OPTIONS: yaml.DumpOptions = {
  indent: 2,
  lineWidth: -1,
  noRefs: true,
  flowLevel: -1,
  sortKeys: false,
  quotingType: "'",
  forceQuotes: false,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Version check
  console.log("Checking SDE build number…");
  const currentBuild = await fetchCurrentBuildNumber();
  const storedBuild = readStoredBuildNumber();

  console.log(`Current build: ${currentBuild}, stored build: ${storedBuild ?? "none"}`);

  if (!FORCE && storedBuild === currentBuild) {
    console.log("SDE build unchanged — nothing to do.");
    process.exit(0);
  }
  if (FORCE && storedBuild === currentBuild) {
    console.log("--force set: running full check despite matching build number.");
  }

  // 2. Download groups (uses local cache if build number matches)
  const groupsMap = await downloadGroupsMap(currentBuild);
  console.log(`Loaded ${groupsMap.size} groups from SDE`);

  // 3 & 4. Process overview files
  const overviewFiles = fs
    .readdirSync(OVERVIEWS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(OVERVIEWS_DIR, f));

  if (overviewFiles.length === 0) {
    console.warn("No overview YAML files found in overviews/");
  }

  const allReferencedIds = new Set<number>();

  interface FileResult {
    filePath: string;
    fileName: string;
    doc: YamlValue;
    presets: PresetRef[];
    staleIds: Map<number, string>;
    modified: boolean;
  }

  const fileResults: FileResult[] = [];

  for (const filePath of overviewFiles) {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = yaml.load(raw) as YamlValue;
    const presets = extractPresets(doc);

    const fileGroupIds = new Set<number>();
    for (const p of presets) {
      for (const id of p.groupIds) {
        fileGroupIds.add(id);
        allReferencedIds.add(id);
      }
    }

    // Stale detection: only strip group IDs completely absent from the SDE.
    // published: false does NOT mean invalid — many celestials (Sun, Stargate,
    // Station) are unpublished in the market sense but are real in-game objects.
    const staleIds = new Map<number, string>();
    for (const id of fileGroupIds) {
      if (!groupsMap.has(id)) {
        staleIds.set(id, "");
      }
    }

    let modified = false;
    if (staleIds.size > 0) {
      stripGroupIds(doc, new Set(staleIds.keys()));
      modified = true;
    }

    fileResults.push({ filePath, fileName: path.basename(filePath), doc, presets, staleIds, modified });
  }

  // 5. New group detection
  interface NewGroup {
    id: number;
    name: string;
    categoryName: string;
  }

  const newGroups: NewGroup[] = [];
  const categoryNameMap = new Map(WATCHED_CATEGORIES.map((c) => [c.id, c.name]));

  for (const [id, group] of groupsMap) {
    if (!group.published) continue;
    if (!WATCHED_CATEGORY_IDS.has(group.categoryID)) continue;
    if (allReferencedIds.has(id)) continue;
    newGroups.push({
      id,
      name: group.name?.en ?? String(id),
      categoryName: categoryNameMap.get(group.categoryID) ?? String(group.categoryID),
    });
  }

  newGroups.sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name));

  const anyStale = fileResults.some((r) => r.staleIds.size > 0);
  const anyNew = newGroups.length > 0;

  // Build PR body regardless (used for both dry-run output and real PR)
  const prBody = buildPrBody(currentBuild, storedBuild, fileResults, newGroups);

  // --- Dry-run: just print and exit ---
  if (DRY_RUN) {
    console.log("\n=== DRY RUN RESULTS ===\n");

    for (const result of fileResults) {
      if (result.staleIds.size > 0) {
        console.log(`${result.fileName}: ${result.staleIds.size} stale ID(s) would be removed:`);
        for (const [id, name] of result.staleIds) {
          console.log(`  - ${id}${name ? ` (${name})` : ""}`);
        }
      } else {
        console.log(`${result.fileName}: no stale IDs`);
      }
    }

    console.log(`\nNew groups in watched categories not yet in any overview: ${newGroups.length}`);
    if (newGroups.length > 0) {
      for (const g of newGroups) {
        console.log(`  + [${g.id}] ${g.name} (${g.categoryName})`);
      }
    }

    console.log("\n=== PR BODY PREVIEW ===\n");
    console.log(prBody);
    process.exit(0);
  }

  // --- Real run ---
  if (!anyStale && !anyNew && storedBuild !== null) {
    console.log("No stale or new groups. Updating build number only.");
  }

  // 6. Write modified YAML files + update build number
  for (const result of fileResults) {
    if (result.modified) {
      const dumped = yaml.dump(result.doc, YAML_DUMP_OPTIONS);
      fs.writeFileSync(result.filePath, dumped, "utf8");
      console.log(`Updated ${result.fileName} (removed ${result.staleIds.size} stale IDs)`);
    }
  }

  fs.mkdirSync(path.dirname(SDE_STATE_FILE), { recursive: true });
  fs.writeFileSync(SDE_STATE_FILE, String(currentBuild) + "\n", "utf8");
  console.log(`Updated sde-build.txt to ${currentBuild}`);

  // 7. Create GitHub PR
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable not set");

  const repoStr = process.env.GITHUB_REPOSITORY;
  if (!repoStr) throw new Error("GITHUB_REPOSITORY environment variable not set (e.g. owner/repo)");
  const [owner, repo] = repoStr.split("/");

  const octokit = new Octokit({ auth: token });
  const branchName = `sde-update/${currentBuild}`;

  const { data: refData } = await octokit.git.getRef({ owner, repo, ref: "heads/main" });
  const baseSha = refData.object.sha;

  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha });
    console.log(`Created branch ${branchName}`);
  } catch (e: unknown) {
    if ((e as { status?: number }).status !== 422) throw e;
    console.log(`Branch ${branchName} already exists, reusing`);
  }

  const filesToCommit: { path: string; content: string }[] = [];
  for (const result of fileResults) {
    if (result.modified) {
      filesToCommit.push({
        path: `overviews/${result.fileName}`,
        content: fs.readFileSync(result.filePath, "utf8"),
      });
    }
  }
  filesToCommit.push({ path: "sde-state/sde-build.txt", content: String(currentBuild) + "\n" });

  const { data: baseCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });

  const treeItems = await Promise.all(
    filesToCommit.map(async (f) => {
      const { data: blob } = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(f.content).toString("base64"),
        encoding: "base64",
      });
      return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
    })
  );

  const { data: newTree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message: `chore: SDE update to build ${currentBuild}`,
    tree: newTree.sha,
    parents: [baseSha],
  });

  await octokit.git.updateRef({ owner, repo, ref: `heads/${branchName}`, sha: newCommit.sha });
  console.log(`Committed changes to ${branchName}`);

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: `chore: SDE update to build ${currentBuild}`,
    head: branchName,
    base: "main",
    body: prBody,
  });

  console.log(`Created PR #${pr.number}: ${pr.html_url}`);
}

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

interface FileResultSummary {
  fileName: string;
  staleIds: Map<number, string>;
  presets: PresetRef[];
}

function buildPrBody(
  currentBuild: number,
  storedBuild: number | null,
  fileResults: FileResultSummary[],
  newGroups: { id: number; name: string; categoryName: string }[]
): string {
  const lines: string[] = [];
  lines.push(`## SDE Update — Build ${currentBuild}`);
  lines.push("");
  if (storedBuild !== null) {
    lines.push(`Previous build: **${storedBuild}** → New build: **${currentBuild}**`);
  } else {
    lines.push(`First recorded build: **${currentBuild}**`);
  }
  lines.push("");

  const staleIdMap = new Map<number, { formerName: string; files: string[]; presets: string[] }>();
  for (const result of fileResults) {
    for (const [id, formerName] of result.staleIds) {
      if (!staleIdMap.has(id)) staleIdMap.set(id, { formerName, files: [], presets: [] });
      const entry = staleIdMap.get(id)!;
      entry.files.push(result.fileName);
      for (const preset of result.presets) {
        if (preset.groupIds.includes(id)) entry.presets.push(preset.presetName);
      }
    }
  }

  const allStale = [...staleIdMap.entries()]
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.id - b.id);

  lines.push("### Stale groups removed");
  lines.push("");
  if (allStale.length === 0) {
    lines.push("_None_");
  } else {
    lines.push("| Group ID | Former Name | Presets |");
    lines.push("|----------|-------------|---------|");
    for (const s of allStale) {
      const presetList = [...new Set(s.presets)].join(", ") || "—";
      lines.push(`| ${s.id} | ${s.formerName || "—"} | ${presetList} |`);
    }
  }
  lines.push("");

  lines.push("### New groups detected");
  lines.push("");
  if (newGroups.length === 0) {
    lines.push("_None_");
  } else {
    lines.push(
      "> These groups exist in the SDE but are not referenced in any overview preset. " +
      "Add them manually if desired."
    );
    lines.push("");
    lines.push("| Group ID | Name | Category |");
    lines.push("|----------|------|----------|");
    for (const g of newGroups) {
      lines.push(`| ${g.id} | ${g.name} | ${g.categoryName} |`);
    }
  }
  lines.push("");

  if (allStale.length === 0 && newGroups.length === 0) {
    lines.push("### No action needed");
    lines.push("");
    lines.push("No stale or new groups were detected. This PR only bumps the recorded SDE build number.");
    lines.push("");
  }

  lines.push("---");
  lines.push("_Generated automatically by [check-sde.ts](scripts/check-sde.ts)_");

  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
