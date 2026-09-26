import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import {
  CreateMcpGroupSchema,
  ReplaceMcpGroupMembersSchema,
  UpdateMcpGroupSchema,
} from "@yusetu/shared";
import { getDb, getSqlite } from "../db/index.js";
import {
  mcpGroupMembers,
  mcpGroups,
  upstreams,
  type McpGroup,
  type User,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { canReadUpstreamRow } from "../upstreams/catalog.js";

function sessionUser(c: Context): User {
  return c.get("user") as User;
}

function serializeGroup(
  row: McpGroup,
  upstreamIds: string[],
): {
  id: string;
  name: string;
  createdAt: string;
  upstreamIds: string[];
} {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    upstreamIds,
  };
}

function loadOwnedGroup(groupId: string, userId: string): McpGroup | undefined {
  return getDb()
    .select()
    .from(mcpGroups)
    .where(and(eq(mcpGroups.id, groupId), eq(mcpGroups.userId, userId)))
    .get();
}

function memberUpstreamIds(groupId: string): string[] {
  return getDb()
    .select({ upstreamId: mcpGroupMembers.upstreamId })
    .from(mcpGroupMembers)
    .where(eq(mcpGroupMembers.groupId, groupId))
    .all()
    .map((r) => r.upstreamId);
}

function nameTaken(
  userId: string,
  name: string,
  exceptGroupId?: string,
): boolean {
  const db = getDb();
  if (exceptGroupId) {
    return !!db
      .select({ id: mcpGroups.id })
      .from(mcpGroups)
      .where(
        and(
          eq(mcpGroups.userId, userId),
          eq(mcpGroups.name, name),
          ne(mcpGroups.id, exceptGroupId),
        ),
      )
      .get();
  }
  return !!db
    .select({ id: mcpGroups.id })
    .from(mcpGroups)
    .where(and(eq(mcpGroups.userId, userId), eq(mcpGroups.name, name)))
    .get();
}

export async function listMcpGroups(c: Context) {
  const user = sessionUser(c);
  const db = getDb();
  const groups = db
    .select()
    .from(mcpGroups)
    .where(eq(mcpGroups.userId, user.id))
    .orderBy(asc(mcpGroups.createdAt))
    .all();

  if (groups.length === 0) return c.json([]);

  const members = db
    .select({
      groupId: mcpGroupMembers.groupId,
      upstreamId: mcpGroupMembers.upstreamId,
    })
    .from(mcpGroupMembers)
    .where(
      inArray(
        mcpGroupMembers.groupId,
        groups.map((g) => g.id),
      ),
    )
    .all();

  const byGroup = new Map<string, string[]>();
  for (const m of members) {
    const list = byGroup.get(m.groupId);
    if (list) list.push(m.upstreamId);
    else byGroup.set(m.groupId, [m.upstreamId]);
  }

  return c.json(
    groups.map((g) => serializeGroup(g, byGroup.get(g.id) ?? [])),
  );
}

export async function createMcpGroup(c: Context) {
  const parsed = CreateMcpGroupSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const user = sessionUser(c);
  if (nameTaken(user.id, parsed.data.name)) {
    return c.json({ error: "Duplicate name" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date();
  getDb()
    .insert(mcpGroups)
    .values({
      id,
      userId: user.id,
      name: parsed.data.name,
      createdAt: now,
    })
    .run();

  getLogger("control").info(
    { groupId: id, userId: user.id },
    "mcp group created",
  );

  return c.json(
    serializeGroup(
      { id, userId: user.id, name: parsed.data.name, createdAt: now },
      [],
    ),
    201,
  );
}

export async function updateMcpGroup(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const parsed = UpdateMcpGroupSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const user = sessionUser(c);
  const row = loadOwnedGroup(id, user.id);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (nameTaken(user.id, parsed.data.name, id)) {
    return c.json({ error: "Duplicate name" }, 400);
  }

  getDb()
    .update(mcpGroups)
    .set({ name: parsed.data.name })
    .where(eq(mcpGroups.id, id))
    .run();

  getLogger("control").info({ groupId: id, userId: user.id }, "mcp group updated");

  return c.json(
    serializeGroup({ ...row, name: parsed.data.name }, memberUpstreamIds(id)),
  );
}

export async function deleteMcpGroup(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const user = sessionUser(c);
  const row = loadOwnedGroup(id, user.id);
  if (!row) return c.json({ error: "Not found" }, 404);

  getDb().delete(mcpGroups).where(eq(mcpGroups.id, id)).run();
  getLogger("control").info({ groupId: id, userId: user.id }, "mcp group deleted");
  return c.body(null, 204);
}

export async function replaceMcpGroupMembers(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const parsed = ReplaceMcpGroupMembersSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const user = sessionUser(c);
  const row = loadOwnedGroup(id, user.id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const upstreamIds = [...new Set(parsed.data.upstreamIds)];
  const db = getDb();
  for (const upstreamId of upstreamIds) {
    const upstream = db
      .select()
      .from(upstreams)
      .where(eq(upstreams.id, upstreamId))
      .get();
    if (!upstream || !canReadUpstreamRow(upstream, user.id)) {
      return c.json({ error: "Upstream not visible" }, 400);
    }
  }

  getSqlite().transaction(() => {
    db.delete(mcpGroupMembers)
      .where(eq(mcpGroupMembers.groupId, id))
      .run();
    for (const upstreamId of upstreamIds) {
      db.insert(mcpGroupMembers)
        .values({ groupId: id, upstreamId })
        .run();
    }
  })();

  getLogger("control").info(
    { groupId: id, userId: user.id, memberCount: upstreamIds.length },
    "mcp group members replaced",
  );

  return c.json(serializeGroup(row, upstreamIds));
}
