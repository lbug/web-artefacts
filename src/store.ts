// Storage layer shared by both runtimes. Each runtime supplies a tiny SQL
// adapter (D1 or node:sqlite) and a blob adapter (R2 or the filesystem);
// everything else - version numbering, listing, comments - lives here.

export type SqlValue = string | number | null;

export interface Sql {
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  run(sql: string, ...params: SqlValue[]): Promise<void>;
}

export interface Blobs {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

export interface ArtifactRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  latest_version: number;
  version_count: number;
  latest_agent: string | null;
  open_comments: number;
}

export interface VersionRow {
  version: number;
  title: string;
  agent: string | null;
  size: number;
  sha256: string;
  created_at: string;
}

export interface CommentRow {
  id: number;
  version: number;
  author: string;
  source: "user" | "agent";
  body: string;
  created_at: string;
  resolved_at: string | null;
}

export class NotFound extends Error {}

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/1/i/l/o

export function newId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

export function isValidId(id: string): boolean {
  return /^[a-z0-9]{4,32}$/.test(id);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const blobKey = (id: string, version: number) => `artifacts/${id}/${version}.html`;

const ARTIFACT_SELECT = `
  SELECT a.id, a.title, a.created_at, a.updated_at,
         (SELECT MAX(version) FROM versions v WHERE v.artifact_id = a.id) AS latest_version,
         (SELECT COUNT(*) FROM versions v WHERE v.artifact_id = a.id) AS version_count,
         (SELECT agent FROM versions v WHERE v.artifact_id = a.id ORDER BY version DESC LIMIT 1) AS latest_agent,
         (SELECT COUNT(*) FROM comments c WHERE c.artifact_id = a.id AND c.resolved_at IS NULL) AS open_comments
  FROM artifacts a`;

export class Store {
  private sql: Sql;
  private blobs: Blobs;

  constructor(sql: Sql, blobs: Blobs) {
    this.sql = sql;
    this.blobs = blobs;
  }

  /** Publishes a new artifact (id omitted) or a new version of an existing one. */
  async publish(input: { id?: string; title?: string; html: string; agent?: string | null }) {
    const now = new Date().toISOString();
    let id = input.id;
    let title = input.title?.trim();

    if (!id) {
      id = newId();
      title ||= "Untitled";
      await this.sql.run(
        "INSERT INTO artifacts (id, title, created_at, updated_at, version_counter) VALUES (?, ?, ?, ?, 0)",
        id, title, now, now,
      );
    }

    // A single UPDATE ... RETURNING is atomic in SQLite and D1, so two agents
    // publishing at once can never receive the same version number.
    const reserved = await this.sql.first<{ version: number; title: string }>(
      `UPDATE artifacts SET version_counter = version_counter + 1, updated_at = ?, title = COALESCE(?, title)
       WHERE id = ? RETURNING version_counter AS version, title`,
      now, title || null, id,
    );
    if (!reserved) throw new NotFound(`Artifact ${id} not found`);

    const size = new TextEncoder().encode(input.html).byteLength;
    await this.blobs.put(blobKey(id, reserved.version), input.html);
    await this.sql.run(
      "INSERT INTO versions (artifact_id, version, title, agent, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, reserved.version, reserved.title, input.agent ?? null, size, await sha256Hex(input.html), now,
    );
    return { id, version: reserved.version, title: reserved.title };
  }

  list(limit = 100): Promise<ArtifactRow[]> {
    // Skip artifacts whose first version never finished writing.
    return this.sql.all<ArtifactRow>(
      `${ARTIFACT_SELECT} WHERE EXISTS (SELECT 1 FROM versions v WHERE v.artifact_id = a.id) ORDER BY a.updated_at DESC LIMIT ?`,
      limit,
    );
  }

  async get(id: string): Promise<ArtifactRow> {
    const row = await this.sql.first<ArtifactRow>(`${ARTIFACT_SELECT} WHERE a.id = ?`, id);
    if (!row || row.latest_version == null) throw new NotFound(`Artifact ${id} not found`);
    return row;
  }

  versions(id: string): Promise<VersionRow[]> {
    return this.sql.all<VersionRow>(
      "SELECT version, title, agent, size, sha256, created_at FROM versions WHERE artifact_id = ? ORDER BY version DESC",
      id,
    );
  }

  /** Returns the HTML of a version (latest when omitted). */
  async html(id: string, version?: number): Promise<{ version: number; html: string }> {
    const v = version ?? (await this.get(id)).latest_version;
    const exists = await this.sql.first("SELECT 1 AS x FROM versions WHERE artifact_id = ? AND version = ?", id, v);
    const html = exists ? await this.blobs.get(blobKey(id, v)) : null;
    if (html == null) throw new NotFound(`Version ${v} of ${id} not found`);
    return { version: v, html };
  }

  comments(id: string, includeResolved = true): Promise<CommentRow[]> {
    return this.sql.all<CommentRow>(
      `SELECT id, version, author, source, body, created_at, resolved_at FROM comments
       WHERE artifact_id = ? ${includeResolved ? "" : "AND resolved_at IS NULL"} ORDER BY id`,
      id,
    );
  }

  async addComment(
    id: string,
    input: { version: number; author: string; body: string; source: "user" | "agent"; resolved?: boolean },
  ): Promise<CommentRow> {
    await this.get(id);
    const now = new Date().toISOString();
    const row = await this.sql.first<CommentRow>(
      `INSERT INTO comments (artifact_id, version, author, source, body, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, version, author, source, body, created_at, resolved_at`,
      id, input.version, input.author, input.source, input.body, now, input.resolved ? now : null,
    );
    return row!;
  }

  async setResolved(id: string, commentIds: number[], resolved: boolean): Promise<void> {
    for (const cid of commentIds) {
      await this.sql.run(
        "UPDATE comments SET resolved_at = ? WHERE artifact_id = ? AND id = ?",
        resolved ? new Date().toISOString() : null, id, cid,
      );
    }
  }
}
