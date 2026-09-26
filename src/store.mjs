/**
 * snapshot の保存。
 * - data/snapshots.jsonl : 1行1スナップショットで追記（履歴）
 * - data/latest/<service>.json : 最新状態を上書き（ダッシュボードが読む）
 */

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function saveSnapshot(snapshot, opts = {}) {
  const out = opts.out ?? path.join("data", "snapshots.jsonl");
  const latestDir = opts.latestDir ?? path.join("data", "latest");

  const outDir = path.dirname(out);
  if (outDir && outDir !== ".") await mkdir(outDir, { recursive: true });
  await appendFile(out, JSON.stringify(snapshot) + "\n", "utf8");

  await mkdir(latestDir, { recursive: true });
  const latestPath = path.join(latestDir, `${snapshot.service}.json`);
  await writeFile(latestPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

  return { out, latestPath };
}
