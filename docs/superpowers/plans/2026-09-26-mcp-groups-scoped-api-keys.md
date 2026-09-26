# MCP Groups and Scoped API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user organize visible MCPs into personal groups and bind API keys to those groups so `/mcp` only exposes the intersection of the user’s catalog and the key’s group members.

**Architecture:** Live group expansion. Tables `mcp_groups`, `mcp_group_members`, `api_key_groups`, plus `api_keys.scope_mode`. `AuthContext` carries optional `apiKeyId` / `scopeMode` from API-key auth. Catalog and tool routing intersect when `scopeMode === "groups"`. Session and OAuth stay unrestricted. Dashboard CRUD for groups and key scope.

**Tech Stack:** Hono, Drizzle, better-sqlite3, Zod (`@yusetu/shared`), React dashboard, verify scripts under `apps/gateway/scripts/` (same pattern as `verify-teams-grants.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-26-mcp-groups-scoped-api-keys-design.md`

## Global Constraints

- Groups are personal (`user_id`). No team-shared groups in v1.
- MCP ↔ group is many-to-many. Key ↔ group is many-to-many.
- Existing keys migrate to `scope_mode = 'unrestricted'`. New keys default to `groups` with empty bindings.
- Scoping applies only when auth is an API key on `/mcp`. Dashboard session and playground ignore key scope.
- Membership is live. Do not flatten upstream ids onto the key.
- Empty scoped catalog returns `[]` / unknown tool. Not 401.
- Follow existing admin handler style (`apps/gateway/src/admin/api-keys.ts`, `grants.ts`) and dashboard page patterns.
- Commit liberally after each task. Do not push unless asked.
- No new vitest harness. Add `apps/gateway/scripts/verify-mcp-groups-scoped-keys.mjs` for behavioral checks.

## File map

| File | Role |
| --- | --- |
| `apps/gateway/src/db/schema.ts` | Drizzle tables + `scopeMode` on `apiKeys` |
| `apps/gateway/src/db/migrate-mcp-groups.ts` | Idempotent migrate + backfill |
| `apps/gateway/src/db/index.ts` | Wire migrate; optional bootstrap CREATE |
| `packages/shared/src/index.ts` | Zod schemas for groups and key create/patch |
| `apps/gateway/src/auth/context.ts` | Optional `apiKeyId`, `scopeMode` on `AuthContext` |
| `apps/gateway/src/middleware/mcp-auth.ts` | Fill key fields on resolve |
| `apps/gateway/src/upstreams/catalog.ts` | Optional scope intersect |
| `apps/gateway/src/mcp/http.ts` | Pass auth scope into facade |
| `apps/gateway/src/mcp/facade.ts` | Thread scope into catalog calls |
| `apps/gateway/src/mcp/router.ts` | Thread scope into visibility check |
| `apps/gateway/src/admin/mcp-groups.ts` | Groups CRUD + members replace |
| `apps/gateway/src/admin/api-keys.ts` | List/create/patch with scope + groups |
| `apps/gateway/src/app.ts` | Mount routes |
| `apps/dashboard/src/api/*` | Client + types |
| `apps/dashboard/src/pages/GroupsPage.tsx` | Groups UI |
| `apps/dashboard/src/pages/SettingsPage.tsx` | Key scope UI |
| `apps/dashboard/src/App.tsx`, `Layout.tsx` | Route + nav |
| `apps/gateway/scripts/verify-mcp-groups-scoped-keys.mjs` | Behavior verify |
| `README.md` | Mark planned items as shipped when done |

---

### Task 1: Schema, migration, shared Zod

**Files:**
- Modify: `apps/gateway/src/db/schema.ts`
- Create: `apps/gateway/src/db/migrate-mcp-groups.ts`
- Modify: `apps/gateway/src/db/index.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: tables `mcpGroups`, `mcpGroupMembers`, `apiKeyGroups`; column `apiKeys.scopeMode`; `migrateMcpGroupsV1(sqlite)`; Zod `CreateMcpGroupSchema`, `UpdateMcpGroupSchema`, `ReplaceMcpGroupMembersSchema`, `CreateApiKeySchema` (extended), `UpdateApiKeySchema`, type `ApiKeyScopeMode = "unrestricted" | "groups"`

- [ ] **Step 1: Add Drizzle tables and column**

In `schema.ts`, after `apiKeys` (extend it):

```ts
scopeMode: text("scope_mode", {
  enum: ["unrestricted", "groups"],
})
  .notNull()
  .default("groups"),
```

Add:

```ts
export const mcpGroups = sqliteTable(
  "mcp_groups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("idx_mcp_groups_user_name").on(t.userId, t.name)],
);

export const mcpGroupMembers = sqliteTable(
  "mcp_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => mcpGroups.id, { onDelete: "cascade" }),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => upstreams.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("idx_mcp_group_members_group_upstream").on(
      t.groupId,
      t.upstreamId,
    ),
  ],
);

export const apiKeyGroups = sqliteTable(
  "api_key_groups",
  {
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => mcpGroups.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("idx_api_key_groups_key_group").on(t.apiKeyId, t.groupId),
  ],
);
```

Match existing drizzle import style in this file for `uniqueIndex` / table helpers.

- [ ] **Step 2: Write `migrate-mcp-groups.ts`**

Mirror `migrate-grants.ts`. Flag `schema_mcp_groups_v1`.

1. `CREATE TABLE IF NOT EXISTS` for the three tables + indexes.
2. `PRAGMA table_info(api_keys)` — if `scope_mode` missing, `ALTER TABLE api_keys ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'groups'`.
3. Before setting the flag (or inside first run), `UPDATE api_keys SET scope_mode = 'unrestricted'` for all rows that exist at migration time. Safe approach: after adding the column with default `groups`, run `UPDATE api_keys SET scope_mode = 'unrestricted'` once when the flag is first set (covers every pre-migration key).
4. Set flag to `1`.

- [ ] **Step 3: Call `migrateMcpGroupsV1` from `migrateSchema` in `index.ts`** after grants migrate.

- [ ] **Step 4: Extend shared Zod**

```ts
export const ApiKeyScopeModeSchema = z.enum(["unrestricted", "groups"]);
export type ApiKeyScopeMode = z.infer<typeof ApiKeyScopeModeSchema>;

export const CreateMcpGroupSchema = z.object({
  name: z.string().min(1).max(128),
});
export type CreateMcpGroup = z.infer<typeof CreateMcpGroupSchema>;

export const UpdateMcpGroupSchema = z.object({
  name: z.string().min(1).max(128),
});
export type UpdateMcpGroup = z.infer<typeof UpdateMcpGroupSchema>;

export const ReplaceMcpGroupMembersSchema = z.object({
  upstreamIds: z.array(z.string().min(1)).max(500),
});
export type ReplaceMcpGroupMembers = z.infer<typeof ReplaceMcpGroupMembersSchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(128),
  scopeMode: ApiKeyScopeModeSchema.optional(),
  groupIds: z.array(z.string().min(1)).max(100).optional(),
});

export const UpdateApiKeySchema = z.object({
  name: z.string().min(1).max(128).optional(),
  scopeMode: ApiKeyScopeModeSchema.optional(),
  groupIds: z.array(z.string().min(1)).max(100).optional(),
});
export type UpdateApiKey = z.infer<typeof UpdateApiKeySchema>;
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @yusetu/shared build && pnpm --filter @yusetu/gateway typecheck`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/db/schema.ts apps/gateway/src/db/migrate-mcp-groups.ts apps/gateway/src/db/index.ts packages/shared/src/index.ts
git commit -m "feat(db): mcp groups schema and api key scope_mode"
```

---

### Task 2: Auth scope + catalog intersection + MCP threading

**Files:**
- Modify: `apps/gateway/src/auth/context.ts`
- Modify: `apps/gateway/src/middleware/mcp-auth.ts`
- Modify: `apps/gateway/src/upstreams/catalog.ts`
- Modify: `apps/gateway/src/mcp/http.ts`
- Modify: `apps/gateway/src/mcp/facade.ts`
- Modify: `apps/gateway/src/mcp/router.ts`
- Any other callers of `catalogToolsForUser` / `isCatalogToolVisible` / `createFacadeServer` that need the optional scope arg (keep session callers unrestricted by omitting scope)

**Interfaces:**
- Consumes: schema tables from Task 1
- Produces:

```ts
export type ApiKeyScopeMode = "unrestricted" | "groups";

export type CatalogKeyScope = {
  apiKeyId: string;
  scopeMode: ApiKeyScopeMode;
};

// AuthContext gains:
apiKeyId?: string;
scopeMode?: ApiKeyScopeMode;

export function visibleUpstreamIdsForUser(
  userId: string,
  keyScope?: CatalogKeyScope,
): Set<string>;

export function catalogToolsForUser(
  userId: string,
  keyScope?: CatalogKeyScope,
): SnapshotTool[];

export function isCatalogToolVisible(
  userId: string,
  tool: SnapshotTool | undefined,
  keyScope?: CatalogKeyScope,
): tool is SnapshotTool;

export function upstreamIdsForApiKeyGroups(apiKeyId: string): Set<string>;
```

When `keyScope` is omitted or `scopeMode === "unrestricted"`, behavior matches today. When `scopeMode === "groups"`, intersect user-visible ids with `upstreamIdsForApiKeyGroups(apiKeyId)`.

- [ ] **Step 1: Extend `AuthContext` and `resolveApiKey`**

Return `{ userId, username, role, apiKeyId: key.id, scopeMode: key.scopeMode as ApiKeyScopeMode }` (validate/default unknown DB values to `"groups"` for safety).

- [ ] **Step 2: Implement catalog helpers**

`upstreamIdsForApiKeyGroups`: join `api_key_groups` → `mcp_group_members` for the key.

`visibleUpstreamIdsForUser`: after building the user set, if `keyScope?.scopeMode === "groups"`, return intersection.

- [ ] **Step 3: Thread scope through MCP**

In `http.ts`, pass `auth` (or `CatalogKeyScope | undefined` derived from auth) into `createFacadeServer` and into `ToolRouter.callTool`.

Change `createFacadeServer(..., userId, keyScope?)` so every `catalogToolsForUser` / `visibleUpstreamIdsForUser` call inside uses that scope.

Change `ToolRouter.callTool(userId, exposedName, args, keyScope?)` to pass scope into `isCatalogToolVisible`.

Playground / admin paths that call the router with session must omit `keyScope`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @yusetu/gateway typecheck`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gateway): scope MCP catalog by API key groups"
```

---

### Task 3: Groups admin API

**Files:**
- Create: `apps/gateway/src/admin/mcp-groups.ts`
- Modify: `apps/gateway/src/app.ts`

**Interfaces:**
- Consumes: Zod schemas, `canReadUpstreamRow`, session user
- Produces: handlers mounted at:
  - `GET /api/mcp-groups`
  - `POST /api/mcp-groups`
  - `PATCH /api/mcp-groups/:id`
  - `DELETE /api/mcp-groups/:id`
  - `PUT /api/mcp-groups/:id/members`

- [ ] **Step 1: Implement handlers**

Ownership: every query filters `mcp_groups.user_id = session.user.id`. 404 if missing or not owned.

`PUT members`: validate body; for each upstream id load row and `canReadUpstreamRow(row, userId)`; on failure 400 `"Upstream not visible"`; replace set in a transaction (delete all members for group, insert new).

Duplicate name → 400.

Response shape for list/get:

```ts
{
  id: string;
  name: string;
  createdAt: string;
  upstreamIds: string[];
}
```

- [ ] **Step 2: Mount routes with `requireSession`**

- [ ] **Step 3: Typecheck + commit**

```bash
git commit -m "feat(gateway): MCP groups admin API"
```

---

### Task 4: API keys list/create/patch with groups

**Files:**
- Modify: `apps/gateway/src/admin/api-keys.ts`
- Modify: `apps/gateway/src/app.ts`

**Interfaces:**
- Consumes: `CreateApiKeySchema`, `UpdateApiKeySchema`, `apiKeyGroups`, `mcpGroups`
- Produces: list/create include `scopeMode` + `groupIds`; `PATCH /api/api-keys/:id`

- [ ] **Step 1: Helper to bind groups**

Given `userId`, `apiKeyId`, `groupIds: string[]`: verify each group belongs to user (else 400); replace `api_key_groups` rows in a transaction.

- [ ] **Step 2: Update create**

Defaults: `scopeMode = parsed.scopeMode ?? "groups"`, `groupIds = parsed.groupIds ?? []`. Insert key with `scopeMode`. Bind groups. Response includes `scopeMode`, `groupIds`, and one-time `key`.

- [ ] **Step 3: Update list**

Join or secondary query for each key’s `groupIds`. Include `scopeMode`.

- [ ] **Step 4: Add `patchApiKey`**

Update name and/or scopeMode and/or replace groupIds. 404 if not owned.

- [ ] **Step 5: Mount `PATCH /api/api-keys/:id`**

- [ ] **Step 6: Typecheck + commit**

```bash
git commit -m "feat(gateway): scoped API key create list and patch"
```

---

### Task 5: Verify script

**Files:**
- Create: `apps/gateway/scripts/verify-mcp-groups-scoped-keys.mjs`

**Interfaces:**
- Consumes: openDb, catalog helpers, createApp optional for HTTP key path

- [ ] **Step 1: Write script** patterned on `verify-teams-grants.mjs`

Seed owner + member, personal + shared upstreams, tools in snapshot, grants as needed.

Assert:

1. Migration creates tables; existing key row set to unrestricted when inserted before migrate simulation (or insert key then check backfill path via fresh DB with migrate).
2. Unrestricted key scope → full user catalog size.
3. Scoped key with one group containing subset → only those tools.
4. Add upstream to group → catalog widens without changing key bindings.
5. Remove last group binding → empty catalog while auth still resolves.
6. `catalogToolsForUser(userId)` without scope still full (session behavior).

- [ ] **Step 2: Run**

Run: `bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-mcp-groups-scoped-keys.mjs`  
Expected: prints success / exit 0

- [ ] **Step 3: Commit**

```bash
git commit -m "test(gateway): verify MCP groups scoped API keys"
```

---

### Task 6: Dashboard Groups page + Settings key scope

**Files:**
- Modify: `apps/dashboard/src/api/types.ts`
- Modify: `apps/dashboard/src/api/index.ts`
- Create: `apps/dashboard/src/pages/GroupsPage.tsx`
- Modify: `apps/dashboard/src/pages/SettingsPage.tsx`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/components/Layout.tsx`

**Interfaces:**
- Consumes: admin APIs from Tasks 3–4
- Produces: `/groups` nav link; Groups CRUD UI; Settings create/edit with scopeMode + multi-select groups

- [ ] **Step 1: API client + types** for `McpGroup`, extended `ApiKey`, `mcpGroupsApi`, `apiKeysApi.patch`

- [ ] **Step 2: GroupsPage**

List groups, create by name, edit members via multi-select of visible MCPs (`upstreamsApi.list` or existing list), rename, delete. Match existing page-header / page-section / btn classes. No new card chrome beyond what Upstreams/Settings already use.

- [ ] **Step 3: SettingsPage**

Create form: name, scope mode select (`groups` default), group multi-select when mode is groups. List shows badge Unrestricted / N groups. Edit control to PATCH scope without reminting. Keep one-time key reveal on create.

- [ ] **Step 4: Route `/groups` + nav label `Groups`** (place near MCPs)

- [ ] **Step 5: Dashboard typecheck**

Run: `pnpm --filter @yusetu/dashboard typecheck`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(dashboard): groups page and scoped API key UI"
```

---

### Task 7: README + opening PR

**Files:**
- Modify: `README.md` What’s next section (groups + scoped keys shipped at MCP/group level)
- Run Opening a PR playbook if on a feature branch; if still on `main`, create branch first

- [ ] **Step 1: Update README planned items** to reflect shipped behavior (MCP groups + key scope by groups)

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: mark MCP groups and scoped keys as available"
```

- [ ] **Step 3: Ensure work is on a feature branch, push, open PR**

Base: `main`. Title/body summarize groups + scoped keys. Link the design spec.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
| --- | --- |
| Personal groups, many-to-many members | 1, 3, 6 |
| Key selects groups; live expansion | 2, 4, 5 |
| `scope_mode` + migrate unrestricted | 1, 5 |
| New keys default groups empty | 4 |
| API-key `/mcp` only | 2 |
| Admin API shapes | 3, 4 |
| Dashboard Groups + Settings | 6 |
| Behavior tests | 5 |
| Per-tool allowlists / team groups | intentionally omitted |
