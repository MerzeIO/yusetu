import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { apiKeysApi, mcpGroupsApi } from "../api";
import type {
  ApiKey,
  ApiKeyScopeMode,
  CreateApiKeyResponse,
} from "../api/types";
import { Modal } from "../components/Modal";
import { mcpGatewayEndpoints } from "../lib/endpoints";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [scopeMode, setScopeMode] = useState<ApiKeyScopeMode>("groups");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editScopeMode, setEditScopeMode] =
    useState<ApiKeyScopeMode>("groups");
  const [editGroupIds, setEditGroupIds] = useState<string[]>([]);

  const endpoints = useMemo(() => mcpGatewayEndpoints(), []);

  const configSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            yusetu: {
              url: endpoints.streamableHttp,
              headers: {
                Authorization: "Bearer <your-api-key>",
              },
            },
          },
        },
        null,
        2,
      ),
    [endpoints.streamableHttp],
  );

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiKeysApi.list(),
  });

  const groupsQuery = useQuery({
    queryKey: ["mcp-groups"],
    queryFn: () => mcpGroupsApi.list(),
  });

  useEffect(() => {
    if (!editing) return;
    setEditScopeMode(editing.scopeMode);
    setEditGroupIds([...editing.groupIds]);
  }, [editing]);

  const createMutation = useMutation({
    mutationFn: () =>
      apiKeysApi.create({
        name: name.trim(),
        scopeMode,
        groupIds: scopeMode === "groups" ? groupIds : [],
      }),
    onSuccess: (data) => {
      setCreated(data);
      setName("");
      setScopeMode("groups");
      setGroupIds([]);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({
      id,
      scopeMode: nextMode,
      groupIds: nextGroups,
    }: {
      id: string;
      scopeMode: ApiKeyScopeMode;
      groupIds: string[];
    }) =>
      apiKeysApi.patch(id, {
        scopeMode: nextMode,
        groupIds: nextMode === "groups" ? nextGroups : [],
      }),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiKeysApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate();
  }

  function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    patchMutation.mutate({
      id: editing.id,
      scopeMode: editScopeMode,
      groupIds: editGroupIds,
    });
  }

  function toggleCreateGroup(id: string) {
    setGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  function toggleEditGroup(id: string) {
    setEditGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  async function copyText(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }

  const groups = groupsQuery.data ?? [];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Connection endpoints and API keys.</p>
        </div>
      </div>

      <section className="page-section">
        <h2>Connection</h2>
        <p className="hint">Point MCP clients at these gateway URLs.</p>

        <div className="field">
          <label>Streamable HTTP</label>
          <div className="copy-row">
            <code className="key-reveal">{endpoints.streamableHttp}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText("streamableHttp", endpoints.streamableHttp)
              }
            >
              {copied === "streamableHttp" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>Health</label>
          <div className="copy-row">
            <code className="key-reveal">{endpoints.health}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void copyText("health", endpoints.health)}
            >
              {copied === "health" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </section>

      <section className="page-section">
        <h2>OAuth discovery</h2>

        <div className="field">
          <label>Protected resource metadata (PRM)</label>
          <div className="copy-row">
            <code className="key-reveal">{endpoints.oauthProtectedResource}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText(
                  "oauthProtectedResource",
                  endpoints.oauthProtectedResource,
                )
              }
            >
              {copied === "oauthProtectedResource" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>Authorization server metadata</label>
          <div className="copy-row">
            <code className="key-reveal">
              {endpoints.oauthAuthorizationServer}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText(
                  "oauthAuthorizationServer",
                  endpoints.oauthAuthorizationServer,
                )
              }
            >
              {copied === "oauthAuthorizationServer" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <div className="section-heading-row">
            <label>Client config example</label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void copyText("snippet", configSnippet)}
            >
              {copied === "snippet" ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="result-box">{configSnippet}</pre>
        </div>
      </section>

      <section className="page-section">
        <h2>Create API key</h2>
        <p className="hint">
          Scoped keys only expose MCPs in the groups you attach. Create groups
          on the Groups page first.
        </p>
        <form className="form" onSubmit={handleCreate}>
          {createMutation.error ? (
            <div className="alert alert-error">
              {createMutation.error instanceof ApiError
                ? createMutation.error.message
                : "Failed to create key."}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="key-name">Name</label>
            <input
              id="key-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cursor-local"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="key-scope">Scope</label>
            <select
              id="key-scope"
              className="select"
              value={scopeMode}
              onChange={(e) =>
                setScopeMode(e.target.value as ApiKeyScopeMode)
              }
            >
              <option value="groups">Groups</option>
              <option value="unrestricted">Unrestricted</option>
            </select>
          </div>
          {scopeMode === "groups" ? (
            <div className="field">
              <label>Groups</label>
              {groupsQuery.isLoading ? (
                <p className="hint">Loading groups…</p>
              ) : null}
              {groupsQuery.error ? (
                <div className="alert alert-error">
                  {groupsQuery.error instanceof ApiError
                    ? groupsQuery.error.message
                    : "Failed to load groups."}
                </div>
              ) : null}
              {groupsQuery.isSuccess && groups.length === 0 ? (
                <p className="hint">
                  No groups yet. The key will expose an empty catalog until you
                  attach groups.
                </p>
              ) : null}
              {groups.map((g) => (
                <label key={g.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(g.id)}
                    onChange={() => toggleCreateGroup(g.id)}
                  />
                  <span>{g.name}</span>
                </label>
              ))}
            </div>
          ) : null}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : "Create key"}
          </button>
        </form>

        {created ? (
          <div className="alert alert-success">
            <p>Copy this key now. It will not be shown again.</p>
            <div className="copy-row">
              <div className="key-reveal">{created.key}</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void navigator.clipboard.writeText(created.key)}
              >
                Copy to clipboard
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="page-section page-section--wide">
        <h2>API keys</h2>
        {keysQuery.isLoading ? <div className="empty">Loading keys…</div> : null}
        {keysQuery.error ? (
          <div className="alert alert-error">
            {keysQuery.error instanceof ApiError
              ? keysQuery.error.message
              : "Failed to load keys."}
          </div>
        ) : null}
        {keysQuery.data && keysQuery.data.length === 0 ? (
          <div className="empty">No API keys yet.</div>
        ) : null}
        {keysQuery.data && keysQuery.data.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {keysQuery.data.map((key) => (
                  <tr key={key.id}>
                    <td className="cell-name">{key.name}</td>
                    <td>{scopeBadge(key)}</td>
                    <td>
                      <code className="cell-slug">{key.keyPrefix}…</code>
                    </td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>
                      {key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}
                    </td>
                    <td className="col-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditing(key)}
                      >
                        Edit scope
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Revoke API key “${key.name}”?`,
                            )
                          ) {
                            deleteMutation.mutate(key.id);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editing ? (
        <Modal
          title={`Edit scope · ${editing.name}`}
          onClose={() => setEditing(null)}
        >
          <form className="form" onSubmit={handleEditSave}>
            {patchMutation.error ? (
              <div className="alert alert-error">
                {patchMutation.error instanceof ApiError
                  ? patchMutation.error.message
                  : "Failed to update scope."}
              </div>
            ) : null}
            <p className="hint">
              Changing scope does not rotate the secret.
            </p>
            <div className="field">
              <label htmlFor="edit-key-scope">Scope</label>
              <select
                id="edit-key-scope"
                className="select"
                value={editScopeMode}
                onChange={(e) =>
                  setEditScopeMode(e.target.value as ApiKeyScopeMode)
                }
              >
                <option value="groups">Groups</option>
                <option value="unrestricted">Unrestricted</option>
              </select>
            </div>
            {editScopeMode === "groups" ? (
              <div className="field">
                <label>Groups</label>
                {groups.length === 0 ? (
                  <p className="hint">No groups yet.</p>
                ) : null}
                {groups.map((g) => (
                  <label key={g.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={editGroupIds.includes(g.id)}
                      onChange={() => toggleEditGroup(g.id)}
                    />
                    <span>{g.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={patchMutation.isPending}
              >
                {patchMutation.isPending ? "Saving…" : "Save scope"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function scopeBadge(key: ApiKey) {
  if (key.scopeMode === "unrestricted") {
    return <span className="badge badge-warning">Unrestricted</span>;
  }
  const n = key.groupIds.length;
  return (
    <span className="badge badge-muted">
      {n === 0 ? "0 groups" : `${n} group${n === 1 ? "" : "s"}`}
    </span>
  );
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
