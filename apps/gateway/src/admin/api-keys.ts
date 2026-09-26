import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { CreateApiKeySchema, UpdateApiKeySchema } from "@yusetu/shared";
import { generateApiKey } from "../auth/crypto.js";
import { getDb, getSqlite } from "../db/index.js";
import {
  apiKeyGroups,
  apiKeys,
  mcpGroups,
  type ApiKey,
  type User,
} from "../db/schema.js";
import { getLogger } from "../logger.js";

function sessionUser(c: Context): User {
  return c.get("user") as User;
}

function serializeApiKey(
  row: ApiKey,
  groupIds: string[],
): {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  scopeMode: "unrestricted" | "groups";
  groupIds: string[];
} {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.prefix,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    scopeMode: row.scopeMode,
    groupIds,
  };
}

function loadOwnedApiKey(apiKeyId: string, userId: string): ApiKey | undefined {
  return getDb()
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.userId, userId)))
    .get();
}

function groupIdsForApiKey(apiKeyId: string): string[] {
  return getDb()
    .select({ groupId: apiKeyGroups.groupId })
    .from(apiKeyGroups)
    .where(eq(apiKeyGroups.apiKeyId, apiKeyId))
    .all()
    .map((r) => r.groupId);
}

function bindGroups(
  userId: string,
  apiKeyId: string,
  groupIds: string[],
): { error: string } | null {
  const unique = [...new Set(groupIds)];
  const db = getDb();
  for (const groupId of unique) {
    const group = db
      .select({ id: mcpGroups.id })
      .from(mcpGroups)
      .where(and(eq(mcpGroups.id, groupId), eq(mcpGroups.userId, userId)))
      .get();
    if (!group) return { error: "Group not owned" };
  }

  getSqlite().transaction(() => {
    db.delete(apiKeyGroups)
      .where(eq(apiKeyGroups.apiKeyId, apiKeyId))
      .run();
    for (const groupId of unique) {
      db.insert(apiKeyGroups)
        .values({ apiKeyId, groupId })
        .run();
    }
  })();

  return null;
}

export async function listApiKeys(c: Context) {
  const user = sessionUser(c);
  const db = getDb();
  const rows = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .all();

  if (rows.length === 0) return c.json([]);

  const bindings = db
    .select({
      apiKeyId: apiKeyGroups.apiKeyId,
      groupId: apiKeyGroups.groupId,
    })
    .from(apiKeyGroups)
    .where(
      inArray(
        apiKeyGroups.apiKeyId,
        rows.map((r) => r.id),
      ),
    )
    .all();

  const byKey = new Map<string, string[]>();
  for (const b of bindings) {
    const list = byKey.get(b.apiKeyId);
    if (list) list.push(b.groupId);
    else byKey.set(b.apiKeyId, [b.groupId]);
  }

  return c.json(
    rows.map((r) => serializeApiKey(r, byKey.get(r.id) ?? [])),
  );
}

export async function createApiKey(c: Context) {
  const parsed = CreateApiKeySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const user = sessionUser(c);
  const scopeMode = parsed.data.scopeMode ?? "groups";
  const groupIds = parsed.data.groupIds ?? [];
  const { raw, prefix, hash } = generateApiKey();
  const id = crypto.randomUUID();
  const now = new Date();
  const db = getDb();

  db.insert(apiKeys)
    .values({
      id,
      name: parsed.data.name,
      keyHash: hash,
      prefix,
      userId: user.id,
      createdAt: now,
      enabled: true,
      scopeMode,
    })
    .run();

  const bindError = bindGroups(user.id, id, groupIds);
  if (bindError) {
    db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
    return c.json({ error: bindError.error }, 400);
  }

  getLogger("control").info({ apiKeyId: id, prefix, userId: user.id }, "api key created");

  return c.json(
    {
      id,
      name: parsed.data.name,
      keyPrefix: prefix,
      key: raw,
      createdAt: now.toISOString(),
      scopeMode,
      groupIds: [...new Set(groupIds)],
    },
    201,
  );
}

export async function patchApiKey(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const parsed = UpdateApiKeySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const user = sessionUser(c);
  const row = loadOwnedApiKey(id, user.id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const updates: { name?: string; scopeMode?: "unrestricted" | "groups" } = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.scopeMode !== undefined) {
    updates.scopeMode = parsed.data.scopeMode;
  }

  if (Object.keys(updates).length > 0) {
    getDb().update(apiKeys).set(updates).where(eq(apiKeys.id, id)).run();
  }

  if (parsed.data.groupIds !== undefined) {
    const bindError = bindGroups(user.id, id, parsed.data.groupIds);
    if (bindError) return c.json({ error: bindError.error }, 400);
  }

  getLogger("control").info({ apiKeyId: id, userId: user.id }, "api key updated");

  const updated = loadOwnedApiKey(id, user.id)!;
  return c.json(serializeApiKey(updated, groupIdsForApiKey(id)));
}

export async function deleteApiKey(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);
  const user = sessionUser(c);
  const db = getDb();
  const row = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return c.body(null, 204);
}
