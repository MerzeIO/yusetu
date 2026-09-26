/**
 * Verifies MCP groups + scoped API key catalog intersection.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-mcp-groups-scoped-keys.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function namesOf(tools) {
  return tools.map((t) => t.exposedName).sort();
}

function sameNames(actual, expected) {
  const a = namesOf(actual);
  const e = [...expected].sort();
  return a.length === e.length && a.every((n, i) => n === e[i]);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-mcp-groups-"));
  process.env.YUSETU_DATA_DIR = dataDir;
  process.env.GATEWAY_MASTER_KEY = crypto.randomBytes(32).toString("base64");

  const { openDb, closeDb, getDb, getSqlite } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  const { hashPassword } = await import(
    path.join(gatewayRoot, "src/auth/crypto.ts")
  );
  const { catalogToolsForUser } = await import(
    path.join(gatewayRoot, "src/upstreams/catalog.ts")
  );
  const { runtimeSnapshot } = await import(
    path.join(gatewayRoot, "src/mcp/snapshot.ts")
  );
  const {
    users,
    upstreams,
    tools,
    apiKeys,
    mcpGroups,
    mcpGroupMembers,
    apiKeyGroups,
  } = await import(path.join(gatewayRoot, "src/db/schema.ts"));

  openDb(path.join(dataDir, "gateway.db"));
  const db = getDb();
  const sqlite = getSqlite();
  const now = new Date();

  for (const tableName of [
    "mcp_groups",
    "mcp_group_members",
    "api_key_groups",
  ]) {
    const table = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(tableName);
    assert(table, `${tableName} table exists after openDb`);
  }

  const scopeCol = sqlite
    .prepare(`PRAGMA table_info(api_keys)`)
    .all()
    .some((c) => c.name === "scope_mode");
  assert(scopeCol, "api_keys has scope_mode");

  const flag = sqlite
    .prepare(`SELECT value FROM settings WHERE key = 'schema_mcp_groups_v1'`)
    .get();
  assert(flag?.value === "1", "schema_mcp_groups_v1 flagged");

  const userId = "user-1";
  const upA = "up-a";
  const upB = "up-b";
  const upC = "up-c";
  const groupId = "group-1";
  const unrestrictedKeyId = "key-unrestricted";
  const scopedKeyId = "key-scoped";
  const defaultKeyId = "key-default-groups";

  const toolA = "mcp-a__ping";
  const toolB = "mcp-b__ping";
  const toolC = "mcp-c__ping";
  const fullCatalog = [toolA, toolB, toolC];

  db.insert(users)
    .values({
      id: userId,
      username: "alice",
      passwordHash: await hashPassword("alice-pass-12"),
      role: "member",
      createdAt: now,
      lastLoginAt: now,
    })
    .run();

  db.insert(upstreams)
    .values([
      {
        id: upA,
        slug: "mcp-a",
        name: "MCP A",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: userId,
        createdAt: now,
        createdByUserId: userId,
      },
      {
        id: upB,
        slug: "mcp-b",
        name: "MCP B",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: userId,
        createdAt: now,
        createdByUserId: userId,
      },
      {
        id: upC,
        slug: "mcp-c",
        name: "MCP C",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: userId,
        createdAt: now,
        createdByUserId: userId,
      },
    ])
    .run();

  db.insert(tools)
    .values([
      {
        id: "tool-a",
        upstreamId: upA,
        originalName: "ping",
        exposedName: toolA,
        enabled: true,
        lastSeenAt: now,
      },
      {
        id: "tool-b",
        upstreamId: upB,
        originalName: "ping",
        exposedName: toolB,
        enabled: true,
        lastSeenAt: now,
      },
      {
        id: "tool-c",
        upstreamId: upC,
        originalName: "ping",
        exposedName: toolC,
        enabled: true,
        lastSeenAt: now,
      },
    ])
    .run();

  runtimeSnapshot.swap([
    {
      upstreamId: upA,
      originalName: "ping",
      slug: "mcp-a",
      exposedName: toolA,
      description: null,
      inputSchema: null,
    },
    {
      upstreamId: upB,
      originalName: "ping",
      slug: "mcp-b",
      exposedName: toolB,
      description: null,
      inputSchema: null,
    },
    {
      upstreamId: upC,
      originalName: "ping",
      slug: "mcp-c",
      exposedName: toolC,
      description: null,
      inputSchema: null,
    },
  ]);

  // Simulated migrate backfill: existing keys stay unrestricted.
  // New inserts omit scopeMode and take the groups default.
  db.insert(apiKeys)
    .values([
      {
        id: unrestrictedKeyId,
        name: "legacy-unrestricted",
        keyHash: "hash-unrestricted",
        prefix: "ysk_unr",
        userId,
        createdAt: now,
        enabled: true,
        scopeMode: "unrestricted",
      },
      {
        id: scopedKeyId,
        name: "scoped",
        keyHash: "hash-scoped",
        prefix: "ysk_scp",
        userId,
        createdAt: now,
        enabled: true,
        scopeMode: "groups",
      },
      {
        id: defaultKeyId,
        name: "default-new",
        keyHash: "hash-default",
        prefix: "ysk_def",
        userId,
        createdAt: now,
        enabled: true,
      },
    ])
    .run();

  const defaultRow = db
    .select({ scopeMode: apiKeys.scopeMode })
    .from(apiKeys)
    .where(eq(apiKeys.id, defaultKeyId))
    .get();
  assert(
    defaultRow?.scopeMode === "groups",
    "new api key insert defaults scope_mode to groups",
  );

  const backfilled = db
    .select({ scopeMode: apiKeys.scopeMode })
    .from(apiKeys)
    .where(eq(apiKeys.id, unrestrictedKeyId))
    .get();
  assert(
    backfilled?.scopeMode === "unrestricted",
    "simulated migrate backfill key stays unrestricted",
  );

  const sessionCatalog = catalogToolsForUser(userId);
  assert(
    sameNames(sessionCatalog, fullCatalog),
    "session catalog (no keyScope) is full",
  );

  const unrestrictedCatalog = catalogToolsForUser(userId, {
    apiKeyId: unrestrictedKeyId,
    scopeMode: "unrestricted",
  });
  assert(
    sameNames(unrestrictedCatalog, fullCatalog),
    "unrestricted keyScope matches full user catalog",
  );
  assert(
    sameNames(unrestrictedCatalog, namesOf(sessionCatalog)),
    "unrestricted key catalog equals session catalog",
  );

  db.insert(mcpGroups)
    .values({
      id: groupId,
      userId,
      name: "subset",
      createdAt: now,
    })
    .run();

  db.insert(mcpGroupMembers)
    .values([
      { groupId, upstreamId: upA },
      { groupId, upstreamId: upB },
    ])
    .run();

  db.insert(apiKeyGroups)
    .values({ apiKeyId: scopedKeyId, groupId })
    .run();

  const scopedCatalog = catalogToolsForUser(userId, {
    apiKeyId: scopedKeyId,
    scopeMode: "groups",
  });
  assert(
    sameNames(scopedCatalog, [toolA, toolB]),
    "scoped key sees only group member upstream tools",
  );
  assert(
    !scopedCatalog.some((t) => t.exposedName === toolC),
    "scoped key omits upstream outside group",
  );

  db.insert(mcpGroupMembers)
    .values({ groupId, upstreamId: upC })
    .run();

  const widened = catalogToolsForUser(userId, {
    apiKeyId: scopedKeyId,
    scopeMode: "groups",
  });
  assert(
    sameNames(widened, fullCatalog),
    "adding upstream to group widens catalog without changing key bindings",
  );

  const bindingCount = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM api_key_groups WHERE api_key_id = ?`)
    .get(scopedKeyId).n;
  assert(bindingCount === 1, "key still has one group binding after widen");

  db.delete(apiKeyGroups)
    .where(eq(apiKeyGroups.apiKeyId, scopedKeyId))
    .run();

  const emptied = catalogToolsForUser(userId, {
    apiKeyId: scopedKeyId,
    scopeMode: "groups",
  });
  assert(
    emptied.length === 0,
    "groups-mode key with no bindings has empty catalog",
  );

  assert(
    sameNames(catalogToolsForUser(userId), fullCatalog),
    "session catalog stays full after key binding removal",
  );

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("verify-mcp-groups-scoped-keys: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
