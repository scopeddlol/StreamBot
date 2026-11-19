import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const tables = [
  "app_settings",
  "users",
  "sessions",
  "secret_records",
  "media_providers",
  "discord_applications",
  "instances",
  "instance_runtime",
  "playlists",
  "playlist_entries",
  "queue_items",
  "playback_checkpoints",
  "permission_rules",
  "request_policies",
  "requests",
  "ai_settings",
  "audit_events",
];
export class AppStore {
  readonly db: Database;
  constructor(readonly dir: string) {
    fs.mkdirSync(path.join(dir, "database"), { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dir, "database/streambot.sqlite"), {
      create: true,
    });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.transaction(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`,
      );
      const version = this.db
        .query("SELECT max(version) AS version FROM schema_migrations")
        .get() as any;
      if (!version.version) {
        this.db.exec(`
          CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
          CREATE TABLE secret_records(id TEXT PRIMARY KEY, purpose TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, key_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE media_providers(id TEXT PRIMARY KEY, config TEXT NOT NULL, secret_id TEXT REFERENCES secret_records(id), revision INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE discord_applications(id TEXT PRIMARY KEY, config TEXT NOT NULL, secret_id TEXT REFERENCES secret_records(id));
          CREATE TABLE instances(id TEXT PRIMARY KEY, config TEXT NOT NULL, secret_id TEXT REFERENCES secret_records(id), revision INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE instance_runtime(instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE, state TEXT NOT NULL, error TEXT, retries INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
          CREATE TABLE playlists(id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, config TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE playlist_entries(id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, position INTEGER NOT NULL, source TEXT NOT NULL);
          CREATE TABLE queue_items(id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, position INTEGER NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
          CREATE TABLE playback_checkpoints(instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE, item_id TEXT, playlist_id TEXT, cursor INTEGER NOT NULL DEFAULT 0, cycle INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
          CREATE TABLE permission_rules(id TEXT PRIMARY KEY, guild_id TEXT, instance_id TEXT REFERENCES instances(id) ON DELETE CASCADE, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL);
          CREATE TABLE request_policies(instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE, config TEXT NOT NULL);
          CREATE TABLE requests(id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, actor TEXT NOT NULL, guild_id TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, secret_id TEXT REFERENCES secret_records(id));
          CREATE TABLE audit_events(id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE INDEX queue_position ON queue_items(instance_id,position);
          CREATE INDEX audit_time ON audit_events(created_at);
          INSERT INTO schema_migrations VALUES(1, unixepoch()*1000);
        `);
      }
    })();
    fs.chmodSync(path.join(dir, "database/streambot.sqlite"), 0o600);
  }
  get<T = any>(sql: string, ...args: any[]): T {
    return this.db.query(sql).get(...args) as T;
  }
  all<T = any>(sql: string, ...args: any[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.query(sql).run(...args);
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.get("SELECT value FROM app_settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.run(
      "INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  audit(actor: string, action: string, target: string, outcome = "success") {
    this.run(
      "INSERT INTO audit_events VALUES(?,?,?,?,?,?)",
      randomUUID(),
      actor,
      action,
      target,
      outcome,
      Date.now(),
    );
    this.run(
      "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events ORDER BY created_at DESC LIMIT -1 OFFSET 20000)",
    );
  }
  close() {
    this.db.close();
  }
}
