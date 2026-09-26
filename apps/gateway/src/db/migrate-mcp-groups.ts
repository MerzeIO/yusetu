import type Database from "better-sqlite3";

const MCP_GROUPS_SCHEMA_FLAG = "schema_mcp_groups_v1";

type ColInfo = { name: string };

function settingGet(sqlite: Database.Database, key: string): string | undefined {
  const row = sqlite
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function settingSet(sqlite: Database.Database, key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function ensureMcpGroupsTables(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS mcp_groups (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_groups_user_name
  ON mcp_groups(user_id, name);

CREATE TABLE IF NOT EXISTS mcp_group_members (
  group_id TEXT NOT NULL REFERENCES mcp_groups(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_group_members_group_upstream
  ON mcp_group_members(group_id, upstream_id);

CREATE TABLE IF NOT EXISTS api_key_groups (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES mcp_groups(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_groups_key_group
  ON api_key_groups(api_key_id, group_id);
`);
}

function ensureApiKeyScopeMode(sqlite: Database.Database): void {
  const cols = sqlite.prepare("PRAGMA table_info(api_keys)").all() as ColInfo[];
  if (!cols.some((c) => c.name === "scope_mode")) {
    sqlite.exec(
      `ALTER TABLE api_keys ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'groups'`,
    );
  }
}

/**
 * MCP groups + api_keys.scope_mode. Idempotent.
 * Existing keys backfill to unrestricted on first run; new keys default to groups.
 */
export function migrateMcpGroupsV1(sqlite: Database.Database): void {
  ensureMcpGroupsTables(sqlite);
  ensureApiKeyScopeMode(sqlite);
  if (settingGet(sqlite, MCP_GROUPS_SCHEMA_FLAG) === "1") {
    return;
  }
  sqlite.exec(`UPDATE api_keys SET scope_mode = 'unrestricted'`);
  settingSet(sqlite, MCP_GROUPS_SCHEMA_FLAG, "1");
  console.info(
    "[yusetu] mcp groups migration complete (existing keys unrestricted)",
  );
}
