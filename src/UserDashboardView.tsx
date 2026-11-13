import { ProviderLogo } from "./components/shared";
import {
  providerCatalog,
  providerEntry,
  providerForTool,
  providerIds,
  providerLabel,
  toolOperation,
} from "../server/provider-catalog";
import {
  ProviderBillingView,
  ProviderAdaptersView,
} from "./ProviderBillingView";
import { useAccount } from "./AccountGate";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Download01,
  GitBranch01,
  Link01,
  RefreshCw01,
  SearchLg,
  Settings02,
  TerminalSquare,
} from "@untitledui/icons";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { api, ApiError, money } from "./api";
import {
  CopyButton,
  Empty,
  InlineError,
  date,
  download,
} from "./observation-ui";
import type { ObservedCall, ToolName } from "../server/observation-types";
import type {
  ActivityItem,
  ActivityPage,
  RoutingPolicy,
  AccountUsage,
} from "../server/account-data-types";
import type { Observatory } from "../server/observation";
import "./user-dashboard.css";
import { ApiKeysView } from "./ApiKeysView";
import { FundingView } from "./FundingView";
import { AgentEnvironment } from "./components/AgentEnvironment";

type Catalog = Awaited<ReturnType<Observatory["catalog"]>>;
type Preview = Awaited<ReturnType<Observatory["preview"]>>;
type Connection = {
  clients: { clientName: string; clientVersion: string; lastSeenAt: string }[];
  providers: Record<string, boolean>;
  sessionBudgetMicros: number;
  requestsPerMinute: number;
};
export type DashboardSection =
  | "overview"
  | "tools"
  | "activity"
  | "usage"
  | "routing"
  | "connections"
  | "credits"
  | "keys";
export const dashboardSections = [
  "overview",
  "tools",
  "activity",
  "usage",
  "routing",
  "connections",
  "credits",
  "keys",
] as const;
const labels: Record<DashboardSection, [string, string]> = {
  overview: [
    "My dashboard",
    "A clear view of the tools working behind your agent.",
  ],
  tools: [
    "Tool catalog",
    "Find the right capability. Compare what each tool returns and costs.",
  ],
  activity: [
    "Activity",
    "Inspect the requests your agent made and the evidence it received.",
  ],
  usage: [
    "Usage",
    "Understand request volume, estimated cost, and provider-reported usage.",
  ],
  routing: [
    "Configure routing",
    "Control which tools are available to agents on this account.",
  ],
  keys: [
    "API keys",
    "Create credentials for your agents and control access and estimated spending.",
  ],
  credits: ["Credits", "Your test balance and deposit history."],
  connections: [
    "Connections",
    "One MCP connection. Your tools, in the agent you already use.",
  ],
};
const toolLabels = Object.fromEntries(
  providerCatalog.map((p) => [p.tool, p.summary]),
) as Record<ToolName, string>;
export { providerLabel };
function latency(ms: number | null | undefined) {
  return ms == null
    ? "—"
    : ms >= 1000
      ? `${(ms / 1000).toFixed(2)} s`
      : `${ms} ms`;
}
function ProviderIcon({ provider }: { provider: string }) {
  return (
    <span
      className={`ws-provider-icon ws-provider-${provider}`}
      aria-hidden="true"
    >
      <ProviderLogo provider={provider} />
    </span>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`ws-status ws-status-${status}`}>
      <span />
      {status === "succeeded"
        ? "Succeeded"
        : status === "failed"
          ? "Failed"
          : status === "running"
            ? "Running"
            : "Interrupted"}
    </span>
  );
}
function Section({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`ws-panel ${className}`}>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function Go({
  section,
  children,
}: {
  section: DashboardSection;
  children: React.ReactNode;
}) {
  return (
    <a className="ws-text-link" href={`#dashboard/${section}`}>
      {children}
      <ArrowUpRight size={14} />
    </a>
  );
}
function NativeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="ws-select">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}
function Loading() {
  return (
    <div className="ws-loading" role="status">
      <span />
      Loading account data…
    </div>
  );
}

export function UserDashboardView({
  section = "overview",
  catalog,
  refreshCatalog,
  connectionRevision,
}: {
  section?: DashboardSection;
  catalog: Catalog;
  refreshCatalog: () => Promise<unknown>;
  connectionRevision: number;
}) {
  const [days, setDays] = useState("7");
  const [usage, setUsage] = useState<AccountUsage>();
  const [policy, setPolicy] = useState<RoutingPolicy>();
  const [connection, setConnection] = useState<Connection>();
  const [activity, setActivity] = useState<ActivityPage>();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [notice, setNotice] = useState("");
  const [selectedCall, setSelectedCall] = useState<ActivityItem>();
  const [selectedTool, setSelectedTool] = useState<Catalog[number]>();
  const generation = useRef(0);
  const activityGeneration = useRef(0);
  const requestKey = `${days}|${query}|${provider}|${status}|${page}|${section}`;
  const currentRequest = useRef(requestKey);
  currentRequest.current = requestKey;
  const load = useCallback(async () => {
    const id = ++generation.current;
    try {
      const [u, p, c] = await Promise.all([
        api<AccountUsage>(`/account/usage?days=${days}`),
        api<RoutingPolicy>("/account/routing"),
        api<Connection>("/account/connection"),
      ]);
      if (generation.current !== id) return;
      setUsage(u);
      setPolicy((current) =>
        current && current.revision > p.revision ? current : p,
      );
      setConnection(c);
      setError("");
    } catch (e) {
      if (generation.current === id) {
        setError((e as Error).message);
        if (e instanceof ApiError && e.status === 401) {
          setUsage(undefined);
          setPolicy(undefined);
          setConnection(undefined);
        }
      }
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }, [days, connectionRevision]);
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    const id = ++activityGeneration.current;
    const key = requestKey;
    setActivityLoading(true);
    setActivityError("");
    const fetchActivity = async () => {
      try {
        const params = new URLSearchParams({
          days,
          q: section === "activity" ? query : "",
          provider: section === "activity" ? provider : "all",
          status: section === "activity" ? status : "all",
          page: section === "activity" ? String(page) : "1",
        });
        const data = await api<ActivityPage>(`/account/activity?${params}`);
        if (
          id === activityGeneration.current &&
          key === currentRequest.current
        ) {
          setActivity(data);
          setActivityError("");
        }
      } catch (e) {
        if (
          id === activityGeneration.current &&
          key === currentRequest.current
        ) {
          setActivityError((e as Error).message);
          setActivity(undefined);
        }
      } finally {
        if (id === activityGeneration.current && key === currentRequest.current)
          setActivityLoading(false);
      }
    };
    const debounce = setTimeout(() => void fetchActivity(), query ? 200 : 0);
    const timer = setInterval(() => void fetchActivity(), 10000);
    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      activityGeneration.current++;
    };
  }, [
    days,
    query,
    provider,
    status,
    page,
    section,
    connectionRevision,
    refreshTick,
  ]);
  async function toggle(tool: ToolName, enabled: boolean) {
    if (!policy || saving) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const next = await api<RoutingPolicy>("/account/routing", {
        revision: policy.revision,
        disabledTools: enabled
          ? policy.disabledTools.filter((t) => t !== tool)
          : [...new Set([...policy.disabledTools, tool])],
      });
      setPolicy(next);
      await refreshCatalog();
      setNotice(
        `${tool} ${enabled ? "enabled" : "paused"}. Routing settings saved.`,
      );
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409) {
        const latest = await api<RoutingPolicy>("/account/routing").catch(
          () => undefined,
        );
        if (latest) setPolicy(latest);
      }
    } finally {
      setSaving(false);
    }
  }
  const ready = catalog.filter(
    (t) => t.available && !policy?.disabledTools.includes(t.tool),
  ).length;
  const enabled = (tool: ToolName) => !policy?.disabledTools.includes(tool);
  const showPeriod = ["overview", "activity", "usage"].includes(section);
  const completed = usage ? usage.succeeded + usage.failed : 0;
  if (section === "keys") {
    return (
      <div className="tool-workspace">
        <ApiKeysView key={connectionRevision} />
      </div>
    );
  }
  return (
    <div className="tool-workspace">
      <div className="page-heading ws-page-heading">
        <div>
          <h1>{labels[section][0]}</h1>
          <p>{labels[section][1]}</p>
        </div>
        <div className="ws-heading-actions">
          {showPeriod && (
            <Select
              value={days}
              onValueChange={(value) => {
                setDays(value);
                setPage(1);
              }}
            >
              <SelectTrigger size="sm" aria-label="Date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label="Refresh account"
            onClick={() => {
              void load();
              void refreshCatalog();
              setRefreshTick((v) => v + 1);
            }}
          >
            <RefreshCw01 size={15} />
          </Button>
          {section === "tools" && (
            <Button variant="outline" size="sm" asChild>
              <a href="#dashboard/routing">
                <Settings02 />
                Configure
              </a>
            </Button>
          )}
          {section === "routing" && (
            <Button variant="outline" size="sm" asChild>
              <a href="#dashboard/tools">
                <ChevronLeft />
                Back to catalog
              </a>
            </Button>
          )}
          {section === "overview" && (
            <Button variant="brand" size="sm" asChild>
              <a href="#dashboard/connections">
                <TerminalSquare />
                Connect agent
              </a>
            </Button>
          )}
        </div>
      </div>
      <InlineError message={error} />
      {notice && (
        <div className="ws-notice" role="status">
          <CheckCircle size={16} />
          {notice}
          <button
            aria-label="Dismiss saved notification"
            onClick={() => setNotice("")}
          >
            Dismiss
          </button>
        </div>
      )}
      {loading && !usage ? (
        <Loading />
      ) : (
        <>
          {(section === "overview" || section === "usage") && (
            <>
              <div className="ws-metrics">
                <Metric
                  label="Estimated cost"
                  value={usage ? money(usage.estimatedMicros) : "—"}
                  hint="Recorded calls · not an invoice"
                  href="#dashboard/usage"
                />
                <Metric
                  label="Tool requests"
                  value={usage?.requests.toLocaleString() ?? "—"}
                  hint={`${usage?.running ?? 0} running · ${usage?.failed ?? 0} failed`}
                  href="#dashboard/activity"
                />
                <Metric
                  label="API success rate"
                  value={
                    completed
                      ? `${((usage!.succeeded / completed) * 100).toFixed(1)}%`
                      : "—"
                  }
                  hint={
                    completed
                      ? `${completed} completed calls · execution only`
                      : "No completed requests in this period"
                  }
                  href="#dashboard/activity"
                />
                <Metric
                  label="Average latency"
                  value={latency(usage?.averageLatencyMs)}
                  hint={`${usage?.latencySamples ?? 0} timed calls`}
                  href="#dashboard/activity"
                />
              </div>
              <div className="ws-chart-grid">
                <Section
                  title="Request volume"
                  description="Daily tool requests · UTC"
                  action={<Go section="activity">View activity</Go>}
                >
                  {usage && <UsageChart usage={usage} />}
                </Section>
                <Section
                  title="Usage by provider"
                  description="Requests in this period"
                  action={<Go section="usage">Details</Go>}
                >
                  <ProviderBreakdown usage={usage} />
                </Section>
              </div>
              {section === "usage" && (
                <Section
                  title="Cost and reported usage"
                  description="Estimates and provider-reported units are kept separate."
                >
                  <div
                    className="ws-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Scrollable request and usage table"
                  >
                    <table className="ws-table">
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Requests</th>
                          <th>Estimated cost</th>
                          <th>Reported credits</th>
                          <th>Reporting coverage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage?.providers.map((p) => (
                          <tr key={p.provider}>
                            <td>
                              <span className="ws-provider-cell">
                                <ProviderIcon provider={p.provider} />
                                {providerLabel(p.provider)}
                              </span>
                            </td>
                            <td>{p.requests}</td>
                            <td>{money(p.estimatedMicros)}</td>
                            <td>{p.reportedCredits ?? "Not reported"}</td>
                            <td>
                              {p.creditReportingCalls} / {p.requests} calls
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="ws-panel-note">
                    Provider-reported USD:{" "}
                    <strong>
                      {usage?.reportedUsd == null
                        ? "Not reported"
                        : money(usage.reportedUsd * 1e6)}
                    </strong>{" "}
                    · {usage?.usdReportingCalls ?? 0} of {usage?.requests ?? 0}{" "}
                    calls reported a USD cost. Partial reporting is not a
                    billing total. Provider credits are not converted to
                    dollars.
                  </div>
                </Section>
              )}
              {section === "overview" && (
                <Section
                  title="Recent requests"
                  description="From the conversations your agent is working on."
                  action={<Go section="activity">All activity</Go>}
                >
                  <InlineError message={activityError} />
                  <ActivityTable
                    items={activity?.items.slice(0, 5) ?? []}
                    loading={activityLoading && !activity}
                    onSelect={setSelectedCall}
                  />
                  <div className="ws-panel-note">
                    Requests appear automatically as your connected agent uses
                    tools.{" "}
                    <a href="#dashboard/tools">
                      Explore the catalog
                      <ArrowRight size={13} />
                    </a>
                  </div>
                </Section>
              )}
              {section === "overview" && (
                <Section
                  title="Available tools"
                  description={`${ready} tools ready for your agent`}
                  action={<Go section="tools">Browse catalog</Go>}
                >
                  <div className="ws-tool-strip">
                    {catalog.map((t) => (
                      <button key={t.tool} onClick={() => setSelectedTool(t)}>
                        <ProviderIcon provider={t.provider} />
                        <span>
                          <strong>{providerLabel(t.provider)}</strong>
                          <small>{toolLabels[t.tool]}</small>
                        </span>
                        <Badge variant="outline">
                          {!t.available
                            ? "Not configured"
                            : enabled(t.tool)
                              ? "Available"
                              : "Paused"}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </Section>
              )}
              {section === "overview" && !connection?.clients.length && (
                <div className="ws-connect-banner">
                  <span className="ws-banner-icon">
                    <TerminalSquare />
                  </span>
                  <div>
                    <strong>Your tools are ready. Bring your agent.</strong>
                    <p>
                      Connect Claude, Codex, or any MCP client to start using{" "}
                      {ready} available tools.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <a href="#dashboard/connections">
                      Set up connection
                      <ArrowRight />
                    </a>
                  </Button>
                </div>
              )}
            </>
          )}
          {section === "activity" && (
            <Section
              title="Request log"
              description="Every provider call, with its inputs, result, and stated selection reason."
              action={
                <ExportActivity
                  days={days}
                  query={query}
                  provider={provider}
                  status={status}
                  total={activity?.total ?? 0}
                />
              }
            >
              <div className="ws-filters">
                <div className="search-input">
                  <SearchLg />
                  <Input
                    aria-label="Search requests"
                    placeholder="Search requests, tools, or sessions…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <NativeSelect
                  label="Provider"
                  value={provider}
                  onChange={(v) => {
                    setProvider(v);
                    setPage(1);
                  }}
                  options={[
                    ["all", "All providers"],
                    ...providerIds.map(
                      (p) => [p, providerLabel(p)] as [string, string],
                    ),
                  ]}
                />
                <NativeSelect
                  label="Request status"
                  value={status}
                  onChange={(v) => {
                    setStatus(v);
                    setPage(1);
                  }}
                  options={[
                    ["all", "All statuses"],
                    ["succeeded", "Succeeded"],
                    ["failed", "Failed"],
                    ["interrupted", "Interrupted"],
                    ["running", "Running"],
                  ]}
                />
              </div>
              <InlineError message={activityError} />
              {activityLoading ? (
                <Loading />
              ) : (
                <ActivityTable
                  items={activity?.items ?? []}
                  onSelect={setSelectedCall}
                  filtered={!!query || provider !== "all" || status !== "all"}
                />
              )}
              <div className="ws-pagination">
                <span>
                  {activity?.total ?? 0} requests · Times shown in your local
                  timezone
                </span>
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page === 1 || activityLoading}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft />
                    Previous
                  </Button>
                  <span>
                    Page {page} of{" "}
                    {Math.max(1, Math.ceil((activity?.total ?? 0) / 20))}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      activityLoading || page * 20 >= (activity?.total ?? 0)
                    }
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </Section>
          )}
          {section === "tools" && (
            <CatalogView
              catalog={catalog}
              enabled={enabled}
              onSelect={setSelectedTool}
            />
          )}
          {section === "routing" && (
            <>
              <div className="ws-routing-explainer">
                <GitBranch01 />
                <div>
                  <strong>
                    Your agent chooses from the tools enabled on your account.
                  </strong>
                  <p>
                    Two Hands matches tools to a request and returns compatible
                    options with estimates. The agent explicitly selects a tool
                    and supplies its reason. Paused tools are excluded from
                    eligible choices and blocked from new calls.
                  </p>
                </div>
              </div>
              <Section
                title="Tool availability"
                description="Saved on the server and applied across connected clients."
                action={<Badge variant="outline">Account policy</Badge>}
              >
                <div className="ws-routing-list">
                  {catalog.map((t) => (
                    <div key={t.tool}>
                      <ProviderIcon provider={t.provider} />
                      <div>
                        <strong>
                          {providerLabel(t.provider)} <code>{t.tool}</code>
                        </strong>
                        <p>
                          {toolLabels[t.tool]} · {money(t.estimatedMicros)}{" "}
                          default estimate
                        </p>
                      </div>
                      <Badge variant="outline">
                        {!t.available
                          ? "Not configured"
                          : enabled(t.tool)
                            ? "Enabled"
                            : "Paused"}
                      </Badge>
                      <Switch
                        aria-label={`${enabled(t.tool) ? "Pause" : "Enable"} ${t.tool}`}
                        checked={enabled(t.tool)}
                        disabled={!policy || saving}
                        onCheckedChange={(value) => void toggle(t.tool, value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="ws-panel-note">
                  Changes apply to new calls immediately. In-flight requests
                  finish and saved receipts remain available.
                  {policy?.updatedAt && (
                    <span> Last saved {date(policy.updatedAt)}.</span>
                  )}
                </div>
              </Section>
              <RoutingPreview revision={policy?.revision} />
              <Section
                title="Execution policy"
                description="Limits are managed by the backend and applied automatically."
              >
                <div className="ws-policy-grid">
                  <div>
                    <span>Tool selection</span>
                    <strong>Explicit agent choice</strong>
                    <small>No silent provider substitution</small>
                  </div>
                  <div>
                    <span>Session limit</span>
                    <strong>
                      {connection ? money(connection.sessionBudgetMicros) : "—"}
                    </strong>
                    <small>Backend authorization per session</small>
                  </div>
                  <div>
                    <span>Request rate</span>
                    <strong>
                      {connection?.requestsPerMinute ?? "—"} / minute
                    </strong>
                    <small>Per provider across this account</small>
                  </div>
                </div>
              </Section>
            </>
          )}
          {section === "usage" && (
            <ProviderBillingView key={connectionRevision} days={days} />
          )}
          {section === "credits" && <FundingView key={connectionRevision} />}
          {section === "connections" && (
            <>
              <ConnectionView connection={connection} catalog={catalog} />
              <ProviderAdaptersView key={connectionRevision} />
            </>
          )}
        </>
      )}
      <Dialog
        open={!!selectedTool}
        onOpenChange={(open) => {
          if (!open) setSelectedTool(undefined);
        }}
      >
        <DialogContent className="ws-detail-dialog translate-x-0 translate-y-0">
          <DialogHeader>
            <DialogTitle>
              {selectedTool ? providerLabel(selectedTool.provider) : "Tool"}
            </DialogTitle>
            <DialogDescription>
              {selectedTool && toolLabels[selectedTool.tool]}
            </DialogDescription>
          </DialogHeader>
          {selectedTool && (
            <ToolDetail
              tool={
                catalog.find((t) => t.tool === selectedTool.tool) ??
                selectedTool
              }
              enabled={enabled(selectedTool.tool)}
              onToggle={(v) => void toggle(selectedTool.tool, v)}
              saving={saving || !policy}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selectedCall}
        onOpenChange={(open) => {
          if (!open) setSelectedCall(undefined);
        }}
      >
        <DialogContent className="ws-detail-dialog translate-x-0 translate-y-0">
          <DialogHeader>
            <DialogTitle>Request details</DialogTitle>
            <DialogDescription>{selectedCall?.sessionTitle}</DialogDescription>
          </DialogHeader>
          {selectedCall && <CallDetail item={selectedCall} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <a className="ws-metric" href={href}>
      <span>
        {label}
        <ArrowUpRight size={13} />
      </span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </a>
  );
}
function UsageChart({ usage }: { usage: AccountUsage }) {
  const maximum = Math.max(2, ...usage.series.map((d) => d.requests));
  return (
    <div
      className="ws-chart"
      aria-label={`${usage.requests} requests over the last ${usage.days} days. ${usage.series.map((d) => `${d.date}: ${d.requests}`).join("; ")}`}
      role="img"
    >
      <div className="ws-chart-labels">
        <span>{maximum}</span>
        <span>{Math.round(maximum / 2)}</span>
        <span>0</span>
      </div>
      <div className="ws-plot">
        <div className="ws-chart-gridlines">
          <i />
          <i />
          <i />
        </div>
        <div
          className="ws-bars"
          style={{
            columnGap: `${Math.min(4, 20 / Math.max(1, usage.series.length))}%`,
          }}
        >
          {usage.series.map((d) => (
            <div
              key={d.date}
              title={`${d.date} UTC · ${d.requests} requests · ${money(d.estimatedMicros)} estimated`}
            >
              <span style={{ height: `${(d.requests / maximum) * 100}%` }} />
            </div>
          ))}
        </div>
        {!usage.requests && (
          <div className="ws-chart-empty">
            <Activity size={21} />
            <strong>No requests in this period</strong>
            <span>Tool usage will appear here automatically.</span>
          </div>
        )}
        <div className="ws-chart-dates">
          <span>{usage.series[0]?.date.slice(5)}</span>
          <span>
            {usage.series[Math.floor(usage.series.length / 2)]?.date.slice(5)}
          </span>
          <span>{usage.series.at(-1)?.date.slice(5)}</span>
        </div>
      </div>
    </div>
  );
}
function ProviderBreakdown({ usage }: { usage?: AccountUsage }) {
  return (
    <div className="ws-provider-breakdown">
      {usage?.providers.map((p) => (
        <div key={p.provider}>
          <div>
            <span className="ws-provider-cell">
              <ProviderIcon provider={p.provider} />
              {providerLabel(p.provider)}
            </span>
            <strong>
              {p.requests.toLocaleString()}
              <small>requests</small>
            </strong>
          </div>
          <div className="ws-meter">
            <span
              style={{
                width: `${usage.requests ? (p.requests / usage.requests) * 100 : 0}%`,
              }}
            />
          </div>
          <p>
            {money(p.estimatedMicros)} estimated
            <span>
              {usage.requests
                ? Math.round((p.requests / usage.requests) * 100)
                : 0}
              % of requests
            </span>
          </p>
        </div>
      ))}
    </div>
  );
}
function ActivityTable({
  items,
  loading,
  onSelect,
  filtered,
}: {
  items: ActivityItem[];
  loading?: boolean;
  onSelect: (i: ActivityItem) => void;
  filtered?: boolean;
}) {
  if (loading) return <Loading />;
  if (!items.length)
    return (
      <Empty
        title={filtered ? "No matching requests" : "No requests yet"}
        action={
          <Button variant="outline" size="sm" asChild>
            <a href={filtered ? "#dashboard/tools" : "#dashboard/connections"}>
              {filtered ? "Explore tools" : "Connect your agent"}
              <ArrowRight />
            </a>
          </Button>
        }
      >
        {filtered
          ? "Try another search, provider, status, or date range."
          : "Use Two Hands tools in your agent. Each call will appear here with its cost estimate and result."}
      </Empty>
    );
  return (
    <div
      className="ws-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Scrollable request and usage table"
    >
      <table className="ws-table ws-activity-table">
        <thead>
          <tr>
            <th>Tool / request</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Est. cost</th>
            <th>Latency</th>
            <th>Time</th>
            <th>
              <span className="sr-only">Inspect</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <button
                  className="ws-request-button"
                  onClick={() => onSelect(item)}
                >
                  <strong>{item.tool}</strong>
                  <span>
                    {item.arguments.query ??
                      item.arguments.url ??
                      item.sessionTitle}
                  </span>
                </button>
              </td>
              <td>
                <span className="ws-provider-cell">
                  <ProviderIcon provider={item.provider} />
                  {providerLabel(item.provider)}
                </span>
              </td>
              <td>
                <Status status={item.status} />
              </td>
              <td className="ws-mono">{money(item.estimateMicros)}</td>
              <td className="ws-mono">{latency(item.latencyMs)}</td>
              <td>
                <time dateTime={item.startedAt}>{date(item.startedAt)}</time>
              </td>
              <td>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Inspect request ${item.id}`}
                  onClick={() => onSelect(item)}
                >
                  <ArrowUpRight />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function CatalogView({
  catalog,
  enabled,
  onSelect,
}: {
  catalog: Catalog;
  enabled: (tool: ToolName) => boolean;
  onSelect: (tool: Catalog[number]) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [sort, setSort] = useState("name");
  const filtered = useMemo(
    () =>
      catalog
        .filter(
          (t) =>
            (!query.trim() ||
              `${t.provider} ${t.tool} ${t.description}`
                .toLowerCase()
                .includes(query.trim().toLowerCase())) &&
            (category === "all" ||
              (toolOperation(t.tool) ?? "search") === category) &&
            (availability === "all" ||
              (availability === "ready"
                ? t.available && enabled(t.tool)
                : !enabled(t.tool))),
        )
        .sort((a, b) =>
          sort === "price"
            ? a.estimatedMicros - b.estimatedMicros
            : a.provider.localeCompare(b.provider),
        ),
    [catalog, query, category, availability, sort, enabled],
  );
  return (
    <>
      <div className="ws-catalog-toolbar">
        <div className="search-input">
          <SearchLg />
          <Input
            aria-label="Search tools"
            placeholder="Search tools, providers, or capabilities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <NativeSelect
          label="Availability"
          value={availability}
          onChange={setAvailability}
          options={[
            ["all", "All tools"],
            ["ready", "Available"],
            ["paused", "Paused"],
          ]}
        />
        <NativeSelect
          label="Sort tools"
          value={sort}
          onChange={setSort}
          options={[
            ["name", "Provider name"],
            ["price", "Lowest default estimate"],
          ]}
        />
      </div>
      <div
        className="ws-category-tabs"
        role="group"
        aria-label="Tool categories"
      >
        {[
          ["all", "All tools"],
          ["search", "Web search"],
          ["extract", "Extraction"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={category === id}
            onClick={() => setCategory(id)}
          >
            {label}
            <span>
              {
                catalog.filter(
                  (t) =>
                    id === "all" || (toolOperation(t.tool) ?? "search") === id,
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      <p className="ws-result-count">
        {filtered.length} tools · Prices are request estimates. Actual options
        affect cost.
      </p>
      <div className="ws-catalog-grid">
        {filtered.map((t) => (
          <article className="ws-tool-card" key={t.tool}>
            <div className="ws-tool-card-top">
              <ProviderIcon provider={t.provider} />
              <Badge variant="outline">
                {!t.available
                  ? "Not configured"
                  : enabled(t.tool)
                    ? "Available"
                    : "Paused"}
              </Badge>
            </div>
            <h2>
              <button onClick={() => onSelect(t)}>
                {providerLabel(t.provider)}
                <ArrowUpRight size={17} />
              </button>
            </h2>
            <code>{t.tool}</code>
            <p>{t.description}</p>
            <div className="ws-tool-tags">
              <span>
                {toolOperation(t.tool) === "extract"
                  ? "Extraction"
                  : "Web search"}
              </span>
              <span>
                {providerEntry(providerForTool(t.tool) ?? "")?.resultDetail ??
                  "Page text"}
              </span>
            </div>
            <div className="ws-tool-stats">
              <div>
                <span>Default estimate</span>
                <strong>
                  {money(t.estimatedMicros)}
                  <small>/ call</small>
                </strong>
              </div>
              <div>
                <span>Observed calls</span>
                <strong>{t.sampleCount.toLocaleString()}</strong>
              </div>
            </div>
            <footer>
              <span>
                {t.averageLatencyMs == null
                  ? "Latency not yet measured"
                  : `${latency(t.averageLatencyMs)} avg. latency`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onSelect(t)}>
                View tool
                <ArrowRight />
              </Button>
            </footer>
          </article>
        ))}
      </div>
      {!filtered.length && (
        <Empty title="No matching tools">
          Try a different capability or clear your filters.
        </Empty>
      )}
      <div className="ws-catalog-footnote">
        <Link01 size={16} />
        Tools are available through a single MCP connection. Provider
        credentials stay on the server.
        <Go section="connections">Connect agent</Go>
      </div>
    </>
  );
}
function ToolDetail({
  tool,
  enabled,
  onToggle,
  saving,
}: {
  tool: Catalog[number];
  enabled: boolean;
  onToggle: (v: boolean) => void;
  saving: boolean;
}) {
  return (
    <div className="ws-tool-detail">
      <div className="ws-detail-tool">
        <ProviderIcon provider={tool.provider} />
        <code>{tool.tool}</code>
        <Badge variant="outline">
          {tool.available ? "Configured" : "Not configured"}
        </Badge>
      </div>
      <p>{tool.description}</p>
      <div className="ws-detail-facts">
        <div>
          <span>Default estimate</span>
          <strong>{money(tool.estimatedMicros)} / call</strong>
        </div>
        <div>
          <span>Account calls</span>
          <strong>{tool.sampleCount}</strong>
        </div>
        <div>
          <span>Average latency</span>
          <strong>{latency(tool.averageLatencyMs)}</strong>
        </div>
        <div>
          <span>API success rate</span>
          <strong>
            {tool.successRate == null
              ? "Needs 5 completed calls"
              : `${(tool.successRate * 100).toFixed(1)}%`}
          </strong>
        </div>
      </div>
      <h3>When to use it</h3>
      <p>{tool.useWhen}</p>
      <h3>What to expect</h3>
      <p>{tool.limitations}</p>
      <h3>Adapter defaults</h3>
      <pre>{JSON.stringify(tool.adapter, null, 2)}</pre>
      <div className="ws-detail-enable">
        <div>
          <strong>Allow on this account</strong>
          <p>Applies to discovery and new provider calls.</p>
        </div>
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={onToggle}
          aria-label={`${enabled ? "Pause" : "Enable"} ${tool.tool}`}
        />
      </div>
      <Button variant="outline" asChild>
        <a
          href={tool.documentationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Provider documentation
          <ArrowUpRight />
        </a>
      </Button>
      <p className="field-hint">
        Observed execution metrics describe this account. API success is not
        answer quality.
      </p>
    </div>
  );
}
function RoutingPreview({ revision }: { revision?: number }) {
  const [operation, setOperation] = useState("search");
  const [value, setValue] = useState("");
  const [content, setContent] = useState("any");
  const [results, setResults] = useState("10");
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setPreview(undefined);
    setError("");
    setBusy(false);
  }, [operation, value, content, results, revision]);
  return (
    <Section
      title="Preview a route"
      description="See compatible tools and request estimates before your agent calls them."
      action={<Badge variant="outline">No provider call · Free</Badge>}
    >
      <form
        className="ws-preview-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const id = ++version.current;
          setBusy(true);
          setError("");
          try {
            const data = await api<Preview>("/account/preview", {
              need: value,
              operations: [
                {
                  operation,
                  ...(operation === "search"
                    ? { query: value, maxResults: Number(results) }
                    : { url: value }),
                  content,
                },
              ],
            });
            if (id === version.current) setPreview(data);
          } catch (e) {
            if (id === version.current) {
              setPreview(undefined);
              setError((e as Error).message);
            }
          } finally {
            if (id === version.current) setBusy(false);
          }
        }}
      >
        <div className="ws-preview-fields">
          <label>
            <span>Operation</span>
            <NativeSelect
              label="Preview operation"
              value={operation}
              onChange={setOperation}
              options={[
                ["search", "Web search"],
                ["extract", "Page extraction"],
              ]}
            />
          </label>
          <label className="ws-preview-query">
            <span>
              {operation === "search" ? "Search query" : "Public HTTPS URL"}
            </span>
            <Input
              aria-label={
                operation === "search" ? "Preview search query" : "Preview URL"
              }
              value={value}
              required
              maxLength={operation === "search" ? 500 : 2048}
              type={operation === "extract" ? "url" : "text"}
              placeholder={
                operation === "search"
                  ? "What does your agent need to find?"
                  : "https://example.com/page"
              }
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <label>
            <span>Required content</span>
            <NativeSelect
              label="Required content"
              value={content}
              onChange={setContent}
              options={[
                ["any", "Any evidence"],
                ["page_text", "Page text"],
                ["complete_page", "Complete page"],
              ]}
            />
          </label>
          {operation === "search" && (
            <label>
              <span>Results</span>
              <NativeSelect
                label="Result count"
                value={results}
                onChange={setResults}
                options={[
                  ["5", "5"],
                  ["10", "10"],
                  ["20", "20"],
                ]}
              />
            </label>
          )}
        </div>
        <Button type="submit" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Preview route"}
          <GitBranch01 />
        </Button>
        <InlineError message={error} />
      </form>
      {preview && (
        <div className="ws-preview-result" role="status">
          <div>
            <strong>
              {preview.candidateTools.length} eligible{" "}
              {preview.candidateTools.length === 1 ? "tool" : "tools"}
            </strong>
            <span>
              Against the {money(preview.budgetMicros)} backend session limit
            </span>
          </div>
          {preview.tools.map((t) => (
            <div className="ws-preview-option" key={t.tool}>
              <code>{t.tool}</code>
              <Badge variant="outline">
                {t.discoveryMatches[0]?.status.replaceAll("_", " ")}
              </Badge>
              <strong>
                {t.requestEstimates[0]
                  ? money(t.requestEstimates[0].estimatedMicros)
                  : "—"}
              </strong>
              <p>{t.discoveryMatches[0]?.reason}</p>
            </div>
          ))}
          <p className="field-hint">
            A preview does not start a session, reserve a budget, or choose a
            provider. The agent makes the final selection.
          </p>
        </div>
      )}
    </Section>
  );
}
function CallDetail({ item }: { item: ActivityItem }) {
  const [call, setCall] = useState<ObservedCall>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let finished = false;
    setCall(undefined);
    setError("");
    const load = async () => {
      try {
        const data = await api<ObservedCall>(
          `/observations/${item.sessionId}/calls/${item.id}`,
        );
        if (active) {
          setCall(data);
          setError("");
          finished = data.status !== "running";
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!finished) void load();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [item.id, item.sessionId]);
  return (
    <div className="ws-call-detail">
      <div className="ws-detail-tool">
        <ProviderIcon provider={item.provider} />
        <code>{item.tool}</code>
        <Status status={call?.status ?? item.status} />
      </div>
      <InlineError message={error} />
      <div className="ws-detail-facts">
        <div>
          <span>Estimated cost</span>
          <strong>{money(item.estimateMicros)}</strong>
        </div>
        <div>
          <span>Latency</span>
          <strong>{latency(call?.latencyMs ?? item.latencyMs)}</strong>
        </div>
        <div>
          <span>Client / model</span>
          <strong>
            {item.host} / {item.model}
          </strong>
          <small>Reported identity</small>
        </div>
        <div>
          <span>Started</span>
          <strong>{date(item.startedAt)}</strong>
        </div>
      </div>
      <h3>Agent’s stated reason</h3>
      <p>{item.statedReason || "No reason recorded"}</p>
      <div className="ws-receipt-id">
        <code>{item.id}</code>
        <CopyButton text={item.id} />
      </div>
      <Tabs defaultValue="request">
        <TabsList>
          <TabsTrigger value="request">Request</TabsTrigger>
          <TabsTrigger value="response">Response</TabsTrigger>
        </TabsList>
        <TabsContent value="request">
          <pre>
            {JSON.stringify(call?.arguments ?? item.arguments, null, 2)}
          </pre>
        </TabsContent>
        <TabsContent value="response">
          {error ? (
            <p>Could not retrieve this receipt.</p>
          ) : !call ? (
            <Loading />
          ) : call.status === "running" ? (
            <p role="status">This request is still running.</p>
          ) : (
            <>
              {call.error && <InlineError message={call.error} />}
              <pre>
                {JSON.stringify(
                  call.result ?? {
                    status: call.status,
                    error: call.error ?? "No result returned",
                  },
                  null,
                  2,
                )}
              </pre>
            </>
          )}
        </TabsContent>
      </Tabs>
      <p className="field-hint">
        Cost estimates and agent-reported explanations are separate from
        provider results. Retrieved content is source material, not
        instructions.
      </p>
    </div>
  );
}
function ConnectionView({
  connection,
  catalog,
}: {
  connection?: Connection;
  catalog: Catalog;
}) {
  const account = useAccount();
  const [client, setClient] = useState("codex");
  const command =
    client === "other"
      ? "npm run mcp:install -- project"
      : `npm run mcp:install -- ${client}`;
  return (
    <>
      <div className="ws-connection-grid">
        <Section
          title="Connect your agent"
          description="Use Two Hands inside your existing conversations."
        >
          <div
            className="ws-client-picker"
            role="group"
            aria-label="Agent client"
          >
            {[
              ["codex", "Codex"],
              ["claude", "Claude"],
              ["other", "Other MCP client"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={client === id}
                onClick={() => setClient(id)}
              >
                <TerminalSquare size={17} />
                {label}
              </button>
            ))}
          </div>
          <p className="ws-panel-note">
            Use a separate scoped credential for each agent.{" "}
            <a href="#dashboard/keys" className="ws-text-link">
              Manage API keys
            </a>{" "}
            before starting the bridge.
          </p>
          <ol className="ws-setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Build the local MCP bridge</strong>
                <p>
                  Run this in the Two Hands project folder. If you run the
                  server locally, keep it running in a separate terminal.
                </p>
                <div className="command-box">
                  <code>npm run build</code>
                  <CopyButton text="npm run build" />
                </div>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Add your connection settings</strong>
                <p>
                  Save these in the bridge project’s private .env file. Replace
                  the placeholder with your API key. The address points to this
                  Two Hands server, including its port.
                </p>
                <AgentEnvironment />
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>
                  {client === "other"
                    ? "Create the MCP configuration"
                    : `Install the ${client === "codex" ? "Codex" : "Claude"} connection`}
                </strong>
                <p>
                  {client === "other"
                    ? "Creates .mcp.json in the project. Use its stdio server entry in your MCP client."
                    : "The installer preserves existing settings and backs up changed files."}
                </p>
                <div className="command-box">
                  <code>{command}</code>
                  <CopyButton text={command} />
                </div>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Restart your client and ask your agent</strong>
                <p>
                  “Use the connected apilayer tools to find evidence for my next
                  task.” Your agent records intent and chooses tools under the
                  backend policy.
                </p>
              </div>
            </li>
          </ol>
        </Section>
        <Section
          title="Connection status"
          description="Client activity recorded for this account."
        >
          <div className="ws-connection-status">
            <span className="ws-banner-icon">
              <TerminalSquare />
            </span>
            <h3>
              {connection?.clients.length
                ? "Client requests observed"
                : "Waiting for your first connection"}
            </h3>
            <p>
              {connection?.clients.length
                ? "These clients have sent requests to Two Hands. Last seen is not a live heartbeat."
                : "Connect an MCP client. It will appear here after its first request."}
            </p>
          </div>
          <div className="ws-client-list">
            {connection?.clients.map((c) => (
              <div key={`${c.clientName}-${c.clientVersion}`}>
                <TerminalSquare size={17} />
                <div>
                  <strong>
                    {c.clientName} <span>{c.clientVersion}</span>
                  </strong>
                  <small>Last seen {date(c.lastSeenAt)}</small>
                </div>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href="#dashboard/activity">
              View request activity
              <ArrowRight />
            </a>
          </Button>
        </Section>
      </div>
      <Section
        title="Provider connections"
        description="Credentials are configured on the server. Their values are never sent to this page."
      >
        <div className="ws-routing-list">
          {catalog.map((t) => (
            <div key={t.tool}>
              <ProviderIcon provider={t.provider} />
              <div>
                <strong>{providerLabel(t.provider)}</strong>
                <p>{t.tool}</p>
              </div>
              <Badge variant="outline">
                {t.available ? "Configured" : "Not configured"}
              </Badge>
            </div>
          ))}
        </div>
        <div className="ws-panel-note">
          {account.enabled && !account.profile?.isAdmin
            ? "Two Hands manages provider availability. Your API keys connect agents to this account."
            : "Missing a provider? Set its API key in the server environment, then restart the server."}
          <Go section="tools">Open tool catalog</Go>
        </div>
      </Section>
    </>
  );
}
function ExportActivity({
  days,
  query,
  provider,
  status,
  total,
}: {
  days: string;
  query: string;
  provider: string;
  status: string;
  total: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="ws-export">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !total}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const params = new URLSearchParams({
              days,
              q: query,
              provider,
              status,
              export: "true",
            });
            const result = await api<ActivityPage>(
              `/account/activity?${params}`,
            );
            const items = result.items;
            const cell = (value: unknown) => {
              const v = String(value ?? "");
              return `"${(/^[=+@\-\t\r]/.test(v) ? "'" : "") + v.replaceAll('"', '""')}"`;
            };
            const columns = [
              "id",
              "sessionId",
              "sessionTitle",
              "tool",
              "provider",
              "status",
              "startedAt",
              "latencyMs",
              "estimateMicros",
              "reportedUsd",
              "reportedCredits",
            ] as const;
            const csv = [
              columns.join(","),
              ...items.map((i) => columns.map((c) => cell(i[c])).join(",")),
            ].join("\r\n");
            download(`two-hands-activity-${days}d.csv`, csv, "text/csv");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download01 />
        {busy ? "Exporting…" : "Export CSV"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
