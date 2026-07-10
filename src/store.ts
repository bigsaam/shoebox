import fs from "node:fs/promises";
import path from "node:path";
import { newId, newSecret, isValidId } from "./ids.js";

/**
 * Layout:
 *   <dataDir>/bundles/<id>/...   the files Caddy serves; nothing else lives here
 *   <dataDir>/meta/<id>.json     ownership, secret, expiry, view counts
 *
 * Metadata is kept *outside* the served tree on purpose. Caddy roots a bundle at
 * bundles/<id>, so there is no path from a public request to a secret — not by
 * traversal, not by misconfiguration, not by forgetting a deny rule.
 */

export interface Bundle {
  id: string;
  /** Original file or directory name, for humans. Never used as a filesystem path. */
  name: string;
  entry: string;
  secret: string;
  createdAt: string;
  expiresAt: string | null;
  bytes: number;
  files: number;
  views: number;
  lastViewedAt: string | null;
}

/**
 * Resolve `relative` inside `root`, refusing anything that escapes.
 * Only used by the built-in file server (path mode / local dev); in the Caddy
 * deployment this code path is not reached.
 */
export function resolveWithin(root: string, relative: string): string | null {
  if (relative.includes("\0")) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, "." + path.posix.resolve("/", relative));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/** A bundle-relative name that is safe to look up (the containment check still runs later). */
export function isSafeEntry(entry: string): boolean {
  if (!entry || entry.includes("\0")) return false;
  if (path.isAbsolute(entry)) return false;
  return !entry.split("/").includes("..");
}

export class Store {
  private readonly bundlesDir: string;
  private readonly metaDir: string;

  constructor(dataDir: string) {
    this.bundlesDir = path.join(dataDir, "bundles");
    this.metaDir = path.join(dataDir, "meta");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.bundlesDir, { recursive: true });
    await fs.mkdir(this.metaDir, { recursive: true });
  }

  bundleDir(id: string): string {
    if (!isValidId(id)) throw new Error(`invalid bundle id: ${id}`);
    return path.join(this.bundlesDir, id);
  }

  private metaPath(id: string): string {
    if (!isValidId(id)) throw new Error(`invalid bundle id: ${id}`);
    return path.join(this.metaDir, `${id}.json`);
  }

  async allocate(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = newId();
      try {
        await fs.mkdir(path.join(this.bundlesDir, id), { recursive: false });
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error("could not allocate a unique bundle id");
  }

  async writeMeta(meta: Bundle): Promise<void> {
    const tmp = `${this.metaPath(meta.id)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmp, this.metaPath(meta.id));
  }

  async read(id: string): Promise<Bundle | null> {
    if (!isValidId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(this.metaPath(id), "utf8")) as Bundle;
    } catch {
      return null;
    }
  }

  async list(): Promise<Bundle[]> {
    const entries = await fs.readdir(this.metaDir).catch(() => []);
    const out: Bundle[] = [];
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const meta = await this.read(file.slice(0, -5));
      if (meta) out.push(meta);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async remove(id: string): Promise<boolean> {
    if (!isValidId(id)) return false;
    const existed = (await this.read(id)) !== null;
    await fs.rm(this.bundleDir(id), { recursive: true, force: true });
    await fs.rm(this.metaPath(id), { force: true });
    return existed;
  }

  /** Fire-and-forget view accounting; a lost increment is not worth failing a page load. */
  async touch(id: string): Promise<void> {
    const meta = await this.read(id);
    if (!meta) return;
    meta.views += 1;
    meta.lastViewedAt = new Date().toISOString();
    await this.writeMeta(meta).catch(() => {});
  }

  async stats(dir: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          files += 1;
          bytes += (await fs.stat(p)).size;
        }
      }
    };
    await walk(dir);
    return { bytes, files };
  }

  newBundle(id: string, name: string, entry: string, ttlMs: number | null): Bundle {
    const now = new Date();
    return {
      id,
      name,
      entry,
      secret: newSecret(),
      createdAt: now.toISOString(),
      expiresAt: ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null,
      bytes: 0,
      files: 0,
      views: 0,
      lastViewedAt: null,
    };
  }

  static isExpired(meta: Bundle, now: number = Date.now()): boolean {
    return meta.expiresAt !== null && Date.parse(meta.expiresAt) <= now;
  }

  /** Delete expired bundles, plus anything created before `olderThanMs` ago when given. */
  async prune(olderThanMs: number | null = null): Promise<string[]> {
    const now = Date.now();
    const removed: string[] = [];
    for (const meta of await this.list()) {
      const tooOld = olderThanMs !== null && Date.parse(meta.createdAt) <= now - olderThanMs;
      if (Store.isExpired(meta, now) || tooOld) {
        if (await this.remove(meta.id)) removed.push(meta.id);
      }
    }
    return removed;
  }
}
