/**
 * category-config.ts
 *
 * Human-editable config: which SDE category IDs to watch for new groups.
 * When the SDE introduces a new group in one of these categories that isn't
 * referenced in any overview file, it will be reported in the PR body.
 *
 * To add/remove a watched category, edit the WATCHED_CATEGORY_IDS set below.
 */

export interface CategoryInfo {
  id: number;
  name: string;
}

/** Categories currently watched for new group detection */
export const WATCHED_CATEGORIES: CategoryInfo[] = [
  { id: 6,  name: "Ship" },
  { id: 11, name: "Entity / NPC" },
  { id: 18, name: "Drone" },
  { id: 22, name: "Deployable" },
  { id: 65, name: "Structure" },
];

export const WATCHED_CATEGORY_IDS: Set<number> = new Set(
  WATCHED_CATEGORIES.map((c) => c.id)
);
