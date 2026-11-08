import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle,
  SearchLg,
  TerminalSquare,
  Link01,
} from "@untitledui/icons";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { money } from "./api";
import {
  Panel,
  Empty,
  CopyButton,
  StateBadge,
  date,
  statusLabel,
} from "./observation-ui";
import type { ObservationListItem } from "../server/observation-types";

type CatalogItem = {
  tool: string;
  provider: string;
  description: string;
  available: boolean;
  estimatedMicros: number;
  sampleCount: number;
  averageLatencyMs: number | null;
  successRate: number | null;
};

type Props = {
  sessions: ObservationListItem[];
  catalog: CatalogItem[];
  estimatedMicros: number;
  connectionName: string | null;
  onRecord: () => void;
};

const STORAGE_KEY = "octolab.enabledTools.v1";

function loadEnabled(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // Ignore corrupt preferences and fall back to all enabled.
  }
  return {};
}

function providerLabel(provider: string) {
  if (provider === "exa") return "Exa";
  if (provider === "tavily") return "Tavily";
  return "Firecrawl";
}

export function UserDashboardView({
  sessions,
  catalog,
  estimatedMicros,
  connectionName,
  onRecord,
}: Props) {
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(loadEnabled);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
    } catch {
      // Private mode etc. Preference stays in memory only.
    }
  }, [enabled]);

  const isEnabled = (tool: string) => enabled[tool] ?? true;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter(
      (item) =>
        !q ||
        `${item.tool} ${item.provider} ${item.description}`
          .toLowerCase()
          .includes(q),
    );
  }, [catalog, query]);

  const enabledCount = catalog.filter((c) => isEnabled(c.tool)).length;
  const needsReview = sessions.filter((s) => statusLabel(s) === "Needs review");
  const recent = [...sessions]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 5);

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>My dashboard</h1>
          <p>Your tools, usage, and connection. Admin review stays separate.</p>
        </div>
        <Button onClick={onRecord}>Record intent</Button>
      </div>

      <div className="summary-grid">
        <div>
          <span>My tools</span>
          <strong>
            {enabledCount}
            <em>/ {catalog.length}</em>
          </strong>
          <small>Enabled for my sessions</small>
        </div>
        <div>
          <span>Estimated spend</span>
          <strong>{money(estimatedMicros)}</strong>
          <small>Provider billing may differ</small>
        </div>
        <div>
          <span>Needs my review</span>
          <strong>{needsReview.length}</strong>
          <small>Outputs waiting for evaluation</small>
        </div>
      </div>

      <Panel
        title="My tools"
        description="Choose which tools your agent may offer. Server availability still applies."
        action={
          <span className="subtle">
            {filtered.length} of {catalog.length} shown
          </span>
        }
      >
        <div className="list-toolbar">
          <div className="search-input">
            <SearchLg />
            <Input
              aria-label="Search my tools"
              placeholder="Search tools…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {filtered.length ? (
          <div className="session-list">
            {filtered.map((item) => (
              <div className="session-row" key={item.tool}>
                <div className="session-name">
                  <span className="session-symbol">
                    <Link01 />
                  </span>
                  <div>
                    <strong>
                      <code className="tool-name">{item.tool}</code>
                    </strong>
                    <span>
                      {providerLabel(item.provider)} ·{" "}
                      {money(item.estimatedMicros)} estimated
                    </span>
                  </div>
                </div>
                <StateBadge
                  label={
                    !item.available
                      ? "Not configured"
                      : isEnabled(item.tool)
                        ? "Enabled"
                        : "Paused"
                  }
                />
                <Switch
                  aria-label={`${isEnabled(item.tool) ? "Pause" : "Enable"} ${item.tool}`}
                  checked={isEnabled(item.tool)}
                  onCheckedChange={(value) =>
                    setEnabled((prev) => ({ ...prev, [item.tool]: value }))
                  }
                />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No matching tools">
            Try another search. Tool availability is managed server side.
          </Empty>
        )}
        <p className="field-hint">
          Pausing a tool hides it from your view. The agent can only call server
          configured tools with an explicit stated reason.
        </p>
      </Panel>

      <Panel
        title="Recent activity"
        description="Your latest sessions and their review state."
        action={
          <Button variant="ghost" size="sm" asChild>
            <a href="#sessions">
              All sessions
              <ArrowUpRight />
            </a>
          </Button>
        }
      >
        {recent.length ? (
          <div className="session-list">
            <div className="session-list-head">
              <span>Session</span>
              <span>Status</span>
              <span>Updated</span>
            </div>
            {recent.map((s) => (
              <a className="session-row" href={`#sessions/${s.id}`} key={s.id}>
                <div className="session-name">
                  <span className="session-symbol">
                    <CheckCircle />
                  </span>
                  <div>
                    <strong>{s.title}</strong>
                    <span>
                      {s.criteria.length} criteria · {money(s.spentMicros)}{" "}
                      estimated
                    </span>
                  </div>
                </div>
                <StateBadge label={statusLabel(s)} />
                <time>{date(s.updatedAt)}</time>
              </a>
            ))}
          </div>
        ) : (
          <Empty
            title="No sessions yet"
            action={<Button onClick={onRecord}>Record intent</Button>}
          >
            Record the expected outcome, then let your agent choose tools and do
            the work.
          </Empty>
        )}
      </Panel>

      <Panel
        title="Connection"
        description="Keys stay server side. This only records that a client connected."
        action={<Badge variant="outline">Local MCP</Badge>}
      >
        <div className="connection-detail">
          <TerminalSquare />
          <div>
            <strong>{connectionName || "No MCP client seen yet"}</strong>
            <p>
              {connectionName
                ? "Your agent is connected. Sessions start automatically under the backend spending policy."
                : "Run the installer, restart your client, and ask your agent to use the connected tools."}
            </p>
          </div>
        </div>
        <div className="command-box">
          <code>npm run mcp:install</code>
          <CopyButton text="npm run mcp:install" />
        </div>
      </Panel>
    </>
  );
}
