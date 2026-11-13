import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Key01,
  Plus,
  RefreshCw01,
} from "@untitledui/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CopyButton, Empty, InlineError, date } from "./observation-ui";
import { api, ApiError } from "./api";
import { AgentEnvironment } from "./components/AgentEnvironment";
import {
  API_KEY_SCOPES,
  API_KEY_TOOLS,
  type ApiKeyScope,
  type WorkspaceApiKey,
  type ApiKeyEvent,
} from "../server/api-key-types";
const labels: Record<ApiKeyScope, [string, string]> = {
  "tools:discover": [
    "Discover tools",
    "Read the tool catalog and preview compatible tools.",
  ],
  "research:read": [
    "Read research",
    "Read your saved sessions, evidence, and activity.",
  ],
  "research:write": [
    "Write research",
    "Record agent intents, connection activity, and delivered outputs.",
  ],
  "tools:execute": [
    "Execute tools",
    "Call allowed providers within backend and key spending limits.",
  ],
  "usage:read": [
    "Read usage",
    "Read your usage totals and provider reporting coverage.",
  ],
};
const statusLabel = {
  active: "Active",
  at_limit: "At spend limit",
  expired: "Expired",
  revoked: "Revoked",
};
const money = (micros: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1e6);
export function ApiKeysView() {
  const [keys, setKeys] = useState<WorkspaceApiKey[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState<
    "create" | "edit" | "secret" | "revoke" | null
  >(null);
  const [selected, setSelected] = useState<WorkspaceApiKey>();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...API_KEY_SCOPES]);
  const [tools, setTools] = useState<string[]>([...API_KEY_TOOLS]);
  const [limit, setLimit] = useState("10");
  const [days, setDays] = useState("30");
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [events, setEvents] = useState<ApiKeyEvent[]>([]);
  const key = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const accessEpoch = useRef(0);
  const ownerApi = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const epoch = accessEpoch.current;
      try {
        const result = await api<T>(path, body);
        if (epoch !== accessEpoch.current)
          throw new ApiError("Owner access changed. Refresh API keys.", 409);
        return result;
      } catch (e) {
        if (
          e instanceof ApiError &&
          [401, 403, 503].includes(e.status) &&
          epoch === accessEpoch.current
        ) {
          accessEpoch.current++;
          generation.current++;
          setKeys([]);
          setMode(null);
          setSelected(undefined);
          setSecret("");
          setRevealed(false);
          setEvents([]);
          setBusy(false);
          setLoading(false);
          setEnabled(false);
          setFormError("");
          setError(e.message);
        }
        throw e;
      }
    },
    [],
  );
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const data = await ownerApi<{
        keys: WorkspaceApiKey[];
        enabled: boolean;
        unavailableReason: string | null;
      }>("/workspace/api-keys");
      if (current === generation.current) {
        setKeys(data.keys);
        setEnabled(data.enabled);
        setUnavailable(data.unavailableReason ?? "");
        setError("");
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [ownerApi]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      generation.current++;
      accessEpoch.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  function close() {
    setMode(null);
    setSelected(undefined);
    setSecret("");
    setRevealed(false);
    setFormError("");
  }
  const changed = () => {
    key.current = crypto.randomUUID();
  };
  async function manage(item: WorkspaceApiKey) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await ownerApi<{
        key: WorkspaceApiKey;
        events: ApiKeyEvent[];
      }>(`/workspace/api-keys/${item.id}`);
      setSelected(data.key);
      setName(data.key.name);
      setScopes(data.key.scopes);
      setTools(data.key.allowedTools);
      setLimit(String(data.key.limitMicros / 1e6));
      setEvents(data.events);
      setSecret("");
      setFormError("");
      setMode("edit");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const matching = keys.filter(
    (k) =>
      (filter === "all" || k.status === filter) &&
      `${k.name} ${k.prefix}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="ws-api-keys">
      <InlineError message={error} />
      {!loading && !enabled && (
        <p className="ws-panel-note">
          {unavailable || "Owner access is required to manage API keys."}
        </p>
      )}
      {notice && (
        <p role="status" className="ws-panel-note">
          {notice}
        </p>
      )}
      <div className="ws-funding-notice">
        <Key01 size={18} />
        <p>
          Give each agent its own key. Limits apply to configured provider-cost
          estimates across all sessions using that key. Actual provider invoices
          can differ.
        </p>
      </div>
      <div className="ws-dispute-controls">
        <Input
          aria-label="Search API keys"
          placeholder="Search name or key prefix…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          <span className="sr-only">Key status</span>
          <select
            aria-label="Key status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All keys</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh API keys"
          onClick={() => void refresh()}
        >
          <RefreshCw01 />
        </Button>
        <Button
          disabled={!enabled || busy}
          onClick={() => {
            setSelected(undefined);
            setName("");
            setScopes([...API_KEY_SCOPES]);
            setTools([...API_KEY_TOOLS]);
            setLimit("10");
            setDays("30");
            setFormError("");
            setNotice("");
            setSecret("");
            setEvents([]);
            changed();
            setMode("create");
          }}
        >
          <Plus />
          Create API key
        </Button>
      </div>
      <section className="ws-panel">
        <header>
          <div>
            <h2>Your API keys</h2>
            <p>
              {
                keys.filter(
                  (k) => k.status === "active" || k.status === "at_limit",
                ).length
              }{" "}
              active credentials · Secrets are shown only when created
            </p>
          </div>
          <Badge variant="outline">Owner managed</Badge>
        </header>
        {loading ? (
          <p role="status" className="ws-panel-note">
            Loading API keys…
          </p>
        ) : matching.length ? (
          <div
            className="ws-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="API keys"
          >
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Estimated spend</th>
                  <th>Limit</th>
                  <th>Expires</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {matching.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Manage ${k.name}`}
                        onClick={() => void manage(k)}
                      >
                        {k.name}
                        <ArrowRight />
                      </Button>
                      <small className="ws-dispute-subline">
                        <code>{k.prefix}</code>
                      </small>
                    </td>
                    <td>{statusLabel[k.status]}</td>
                    <td>
                      {money(k.spentMicros)}
                      <small className="ws-dispute-subline">
                        {money(k.reservedMicros)} reserved
                      </small>
                    </td>
                    <td>{money(k.limitMicros)} total</td>
                    <td>{date(k.expiresAt)}</td>
                    <td>{k.lastUsedAt ? date(k.lastUsedAt) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={keys.length ? "No matching keys" : "No API keys yet"}>
            Create a scoped credential for an agent or application. Provider
            credentials remain on the server.
          </Empty>
        )}
      </section>
      <section className="ws-panel">
        <header>
          <div>
            <h2>Connect an agent</h2>
            <p>Use a scoped credential with the local MCP bridge.</p>
          </div>
        </header>
        <div className="ws-key-instructions">
          <p>
            Add these settings to the bridge project’s private .env file.
            Replace the placeholder with your saved API key, then restart your
            MCP client. Never use a provider credential here.
          </p>
          <AgentEnvironment />
          <p>
            Each key is tied to your account and limited to the permissions and
            tools you allow. Manage or revoke it here without changing other
            agents’ keys.
          </p>
          <a className="ws-text-link" href="#dashboard/connections">
            MCP connection setup
            <ArrowRight size={14} />
          </a>
        </div>
      </section>
      <Dialog
        open={!!mode}
        onOpenChange={(value) => {
          if (!value && !busy) close();
        }}
      >
        <DialogContent className="ws-detail-dialog translate-x-0 translate-y-0">
          <DialogHeader>
            <DialogTitle>
              {mode === "create"
                ? "Create API key"
                : mode === "secret"
                  ? "Save your API key"
                  : mode === "revoke"
                    ? "Revoke API key"
                    : "Manage API key"}
            </DialogTitle>
            <DialogDescription>
              {mode === "secret"
                ? "Copy this credential now. Its full value cannot be retrieved again."
                : mode === "revoke"
                  ? "New requests stop immediately. Already admitted provider calls can finish and settle their reserved estimates."
                  : "Set permissions, allowed tools, and a total estimated-spend limit."}
            </DialogDescription>
          </DialogHeader>
          <InlineError message={formError} />
          {mode === "edit" && notice && (
            <p role="status" className="ws-panel-note">
              {notice}
            </p>
          )}
          {mode === "secret" ? (
            <div className="ws-deposit-detail">
              <strong>{selected?.name}</strong>
              {secret ? (
                <>
                  <div className="ws-key-secret">
                    <Input
                      aria-label="New API key secret"
                      type={revealed ? "text" : "password"}
                      value={secret}
                      readOnly
                      autoComplete="off"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={revealed ? "Hide API key" : "Reveal API key"}
                      onClick={() => setRevealed((v) => !v)}
                    >
                      {revealed ? <EyeOff /> : <Eye />}
                    </Button>
                    <CopyButton text={secret} />
                  </div>
                  <p>
                    Store this key in your application’s secret settings.
                    Closing this dialog clears it from the page.
                  </p>
                </>
              ) : (
                <p>
                  This request already created a key. Its secret is no longer
                  available. Revoke that key and create another if the original
                  response was lost.
                </p>
              )}
              <div className="button-row">
                <Button onClick={close}>Done</Button>
                <Button variant="outline" asChild>
                  <a href="#dashboard/connections" onClick={close}>
                    Agent connection setup
                    <ArrowRight />
                  </a>
                </Button>
              </div>
            </div>
          ) : mode === "revoke" && selected ? (
            <div className="ws-deposit-detail">
              <strong>{selected.name}</strong>
              <code>{selected.prefix}</code>
              <p>
                Revocation is permanent. Other keys and saved receipts remain
                available.
              </p>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setFormError("");
                  try {
                    await ownerApi(
                      `/workspace/api-keys/${selected.id}/revoke`,
                      {
                        revision: selected.revision,
                      },
                    );
                    setNotice(`${selected.name} revoked.`);
                    close();
                    await refresh();
                  } catch (e) {
                    setFormError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Revoking…" : "Revoke this key"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                Keep key
              </Button>
            </div>
          ) : (
            <form
              className="ws-deposit-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setFormError("");
                try {
                  const body = {
                    name,
                    scopes,
                    allowedTools: tools,
                    limitUsd: limit,
                  };
                  if (mode === "create") {
                    const result = await ownerApi<{
                      key: WorkspaceApiKey;
                      secret: string | null;
                    }>("/workspace/api-keys", {
                      ...body,
                      requestKey: key.current,
                      expiresInDays: Number(days),
                    });
                    setSelected(result.key);
                    setSecret(result.secret ?? "");
                    setRevealed(false);
                    setMode("secret");
                  } else if (selected) {
                    const result = await ownerApi<WorkspaceApiKey>(
                      `/workspace/api-keys/${selected.id}`,
                      { ...body, revision: selected.revision },
                    );
                    setSelected(result);
                    setNotice("API key settings updated.");
                    setEvents(
                      (
                        await ownerApi<{ events: ApiKeyEvent[] }>(
                          `/workspace/api-keys/${selected.id}`,
                        )
                      ).events,
                    );
                  }
                  await refresh();
                } catch (e) {
                  setFormError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                <span>Key name</span>
                <Input
                  aria-label="API key name"
                  value={name}
                  maxLength={80}
                  required
                  disabled={busy || !!selected?.revokedAt}
                  onChange={(e) => {
                    setName(e.target.value);
                    changed();
                  }}
                  placeholder="Codex development"
                />
              </label>
              <label>
                <span>Permission preset</span>
                <select
                  aria-label="Permission preset"
                  disabled={busy || !!selected?.revokedAt}
                  value={
                    scopes.length === API_KEY_SCOPES.length
                      ? "agent"
                      : scopes.length === 3 &&
                          scopes.includes("usage:read") &&
                          !scopes.includes("tools:execute") &&
                          !scopes.includes("research:write")
                        ? "read"
                        : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value === "agent")
                      setScopes([...API_KEY_SCOPES]);
                    else if (e.target.value === "read")
                      setScopes([
                        "tools:discover",
                        "research:read",
                        "usage:read",
                      ]);
                    changed();
                  }}
                >
                  <option value="agent">Agent access</option>
                  <option value="read">Read only</option>
                  <option value="custom">Custom permissions</option>
                </select>
              </label>
              <fieldset className="ws-key-options">
                <legend>Permissions</legend>
                {API_KEY_SCOPES.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      disabled={busy || !!selected?.revokedAt}
                      onChange={(e) => {
                        setScopes((v) =>
                          e.target.checked
                            ? [...v, scope]
                            : v.filter((x) => x !== scope),
                        );
                        changed();
                      }}
                    />
                    <span>
                      <strong>{labels[scope][0]}</strong>
                      <small>{labels[scope][1]}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="ws-key-options">
                <legend>Allowed tools</legend>
                {API_KEY_TOOLS.map((tool) => (
                  <label key={tool}>
                    <input
                      type="checkbox"
                      checked={tools.includes(tool)}
                      disabled={busy || !!selected?.revokedAt}
                      onChange={(e) => {
                        setTools((v) =>
                          e.target.checked
                            ? [...v, tool]
                            : v.filter((x) => x !== tool),
                        );
                        changed();
                      }}
                    />
                    <span>
                      <strong>{tool}</strong>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label>
                <span>Total estimated-spend limit in USD</span>
                <Input
                  aria-label="API key spend limit"
                  inputMode="decimal"
                  value={limit}
                  required
                  disabled={busy || !!selected?.revokedAt}
                  onChange={(e) => {
                    setLimit(e.target.value);
                    changed();
                  }}
                />
                <small>
                  $0–$1,000, up to six decimal places. Includes estimates spent
                  and currently reserved. This is a lifetime limit, separate
                  from each session’s backend cap.
                </small>
              </label>
              {mode === "create" ? (
                <label>
                  <span>Expires after</span>
                  <select
                    aria-label="API key expiry"
                    value={days}
                    onChange={(e) => {
                      setDays(e.target.value);
                      changed();
                    }}
                  >
                    {[7, 30, 90, 365].map((n) => (
                      <option value={n} key={n}>
                        {n} days
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                selected && (
                  <div className="ws-detail-facts">
                    <div>
                      <span>Expires</span>
                      <strong>{date(selected.expiresAt)}</strong>
                    </div>
                    <div>
                      <span>Spent / reserved estimates</span>
                      <strong>
                        {money(selected.spentMicros)} /{" "}
                        {money(selected.reservedMicros)}
                      </strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <strong>{statusLabel[selected.status]}</strong>
                    </div>
                    <div>
                      <span>Revision</span>
                      <strong>{selected.revision}</strong>
                    </div>
                  </div>
                )
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  !!selected?.revokedAt ||
                  scopes.length === 0 ||
                  tools.length === 0
                }
              >
                {busy
                  ? "Saving…"
                  : mode === "create"
                    ? "Create key"
                    : "Save key settings"}
              </Button>
              {selected && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void manage(selected)}
                  >
                    Reload saved settings
                  </Button>
                  {!selected.revokedAt && (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setFormError("");
                        setMode("revoke");
                      }}
                    >
                      Revoke key
                    </Button>
                  )}
                  <h3>Key audit history</h3>
                  {events.length ? (
                    <ol className="ws-dispute-history">
                      {events.map((event) => (
                        <li key={event.id}>
                          <strong>
                            {event.type} · Revision {event.current.revision}
                          </strong>
                          <small className="ws-dispute-subline">
                            {date(event.at)} · Account owner credential
                          </small>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>No key changes recorded.</p>
                  )}
                </>
              )}
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
