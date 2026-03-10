/**
 * sde-client.ts
 *
 * Shared SDE fetch + cache logic used by check-sde.ts, validate.ts, and pr-command.ts.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";
import yauzl from "yauzl";

// ---------------------------------------------------------------------------
// Types (exported for consumers)
// ---------------------------------------------------------------------------

export interface SdeRecord {
  _key: string;
  buildNumber: number;
  [key: string]: unknown;
}

export interface Group {
  _key: number;
  name: { en: string; [lang: string]: string };
  categoryID: number;
  published: boolean;
  [key: string]: unknown;
}

interface GroupsCache {
  buildNumber: number;
  groups: Group[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GROUPS_CACHE_FILE = path.join(REPO_ROOT, "sde-state", "groups-cache.json");

export const SDE_VERSION_URL =
  "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
export const SDE_ZIP_URL =
  "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function fetchText(url: string): Promise<string> {
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

export function fetchBuffer(url: string): Promise<Buffer> {
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
// Build number
// ---------------------------------------------------------------------------

export async function fetchCurrentBuildNumber(): Promise<number> {
  const text = await fetchText(SDE_VERSION_URL);
  const record = JSON.parse(text.trim()) as SdeRecord;
  return record.buildNumber;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Download & parse groups.jsonl
// ---------------------------------------------------------------------------

async function downloadGroupsMap(buildNumber: number): Promise<Map<number, Group>> {
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
        if (groups.size === 0) reject(new Error("groups.jsonl not found in SDE zip"));
      });
      zipfile.on("error", reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load groups map, using local cache if available for this build number. */
export async function loadGroupsMap(buildNumber: number): Promise<Map<number, Group>> {
  return loadGroupsCache(buildNumber) ?? downloadGroupsMap(buildNumber);
}
