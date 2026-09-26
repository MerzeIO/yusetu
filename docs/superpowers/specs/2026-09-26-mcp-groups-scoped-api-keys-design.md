# MCP groups and scoped API keys

About personal MCP groups as use-case bundles, and API keys that expose only the MCPs in the groups you attach. This sits on top of the per-user catalog from [Teams and per-user MCP isolation](./2026-09-26-teams-tenant-isolation-design.md).

## Goals

- Let each user organize visible MCPs into named groups by use case (for example coding, ops, review).
- Let an MCP belong to more than one group.
- Let each API key select one or more of that user’s groups and expose only the union of those groups’ members.
- Keep existing API keys working after upgrade without a remint.
- Keep the dashboard session and playground on the full user catalog.

## Non-goals (v1)

- Shared or team-owned groups
- Per-tool allowlists inside a group or on a key
- Scoping OAuth gateway tokens (`ysat_`) or session cookies
- Flattened per-key upstream snapshots (membership stays live)
- Auto-creating default groups on upgrade

## Relationship to teams v1

Teams v1 marked “per-key tool allowlists” as a non-goal. This design adds **per-key MCP scope via groups**, not per-tool allowlists. Tool-level allowlists remain out of scope.

Catalog visibility still starts with the teams rule. A key never sees an MCP the owning user cannot see. Group membership is a second filter on that set.

## Domain model

### `mcp_groups`

| Column | Notes |
| --- | --- |
| `id` | Primary key |
| `user_id` | Owner. Cascade delete with user |
| `name` | Display name. Unique per `user_id` |
| `created_at` | Timestamp |

### `mcp_group_members`

| Column | Notes |
| --- | --- |
| `group_id` | FK to `mcp_groups` |
| `upstream_id` | FK to `upstreams` |
| Unique | `(group_id, upstream_id)` |

At write time the upstream must be visible to the group owner (personal owned by them, or shared they may read under grants / elevated role). Reject otherwise.

### `api_key_groups`

| Column | Notes |
| --- | --- |
| `api_key_id` | FK to `api_keys` |
| `group_id` | FK to `mcp_groups` |
| Unique | `(api_key_id, group_id)` |

Key and group must share the same `user_id`. Reject cross-user binds.

### `api_keys.scope_mode`

Values: `unrestricted` | `groups`.

- Migration sets every existing key to `unrestricted`.
- New keys default to `groups` with zero `api_key_groups` rows until the user attaches groups.

### Runtime catalog for an API key

1. Build the user’s visible enabled upstream set (`visibleUpstreamIdsForUser`).
2. If `scope_mode` is `unrestricted`, that set is the catalog.
3. If `scope_mode` is `groups`, intersect with the union of `mcp_group_members.upstream_id` for groups bound in `api_key_groups`.
4. Ungrouped MCPs never appear on a scoped key. They still appear for unrestricted keys and for the dashboard.

Deleting a group deletes its member rows and key bindings. A scoped key that loses its last group keeps `scope_mode = groups` and exposes an empty catalog until the user attaches another group or switches to `unrestricted`.

## Auth and enforcement

Extend `AuthContext` for MCP data-plane callers that authenticated with an API key.

```ts
type AuthContext = {
  userId: string;
  username: string;
  role: Role;
  apiKeyId?: string;
  scopeMode?: "unrestricted" | "groups";
};
```

`resolveApiKey` sets `apiKeyId` and `scopeMode`. Session cookies and OAuth access tokens omit them. Catalog helpers treat missing scope as full-user (same as unrestricted for that request).

Apply the intersection in the same place that builds the MCP tool list and that authorizes tool calls (`catalog.ts` / MCP facade and router). A tool whose upstream falls outside the intersection follows the existing unknown / not-allowed path. Do not invent a separate error code for “scoped out.”

Admin and dashboard routes stay on session auth and ignore key scope.

## API surface (session auth)

### Groups

- `GET /api/mcp-groups` — list the caller’s groups with member upstream ids
- `POST /api/mcp-groups` — `{ name }`
- `PATCH /api/mcp-groups/:id` — `{ name }`
- `DELETE /api/mcp-groups/:id`
- `PUT /api/mcp-groups/:id/members` — `{ upstreamIds: string[] }` replaces the member set

### API keys

- `POST /api/api-keys` — `{ name, scopeMode?, groupIds? }`  
  Defaults when omitted: `scopeMode: "groups"`, `groupIds: []`
- `PATCH /api/api-keys/:id` — `{ name?, scopeMode?, groupIds? }` so scope can change without reminting the secret
- `GET /api/api-keys` — include `scopeMode` and bound `groupIds`
- `DELETE /api/api-keys/:id` — unchanged

### Write-time errors (HTTP 400)

- Group member upstream not visible to the owner
- Key or group user mismatch on bind
- Invalid `scopeMode`
- Empty name or duplicate group name for that user

### Runtime with a valid scoped key

Empty group set or empty intersection after filter. `tools/list` returns `[]`. Tool calls fail like an unknown tool. Response is not 401. The key authenticated successfully.

## Dashboard

- **Groups** page (or a Groups section under MCPs). Create, rename, delete. Multi-select members from the user’s visible MCP catalog.
- **Settings → API keys.** Create flow chooses scope mode and groups. List shows an unrestricted vs groups badge. Edit updates mode and group bindings without rotating the secret.

## Migration

1. Create `mcp_groups`, `mcp_group_members`, and `api_key_groups`.
2. Add `api_keys.scope_mode` with application default `groups` for inserts.
3. Backfill every existing row to `scope_mode = 'unrestricted'`.
4. Create no groups automatically.

## Tests

Assert behavior, not internal helpers alone.

- Unrestricted key sees the full user catalog.
- Scoped key sees only (union of bound group members) ∩ visible catalog.
- Adding an MCP to a group widens every bound key on the next catalog build.
- Removing the last group from a scoped key yields an empty catalog.
- Session and playground still see the full user catalog.
- A member cannot add another user’s personal MCP to their group.
- Existing keys remain unrestricted after migration.

## Design choices

**Live group expansion over flattened key allowlists.** Editing group membership should change what bound keys see without rewriting every key. The catalog path already filters by user. One more intersection is enough.

**Personal groups only in v1.** API keys are per-user. Personal groups match that boundary and avoid a grant matrix for group visibility.

**API-key enforcement only.** Groups are for client-specific views (Cursor, agents). The dashboard remains the full control plane.

**Explicit `scope_mode` over “empty bindings mean all.”** Empty bindings mean empty catalog for scoped keys. Unrestricted is opt-in and is what migration preserves.
