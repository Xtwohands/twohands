import { useEffect, useState, useCallback, useRef } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Download,
  FileSearch,
  Fingerprint,
  GitBranch,
  Globe2,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { ServerHealth, TaskSummary } from "../server/types";
import { api, money, setToken, type TaskDetail } from "./api";
import { Stat, ProviderMark } from "./components/shared";
import { IntentForm } from "./components/IntentForm";
import { CompanyResults, FollowUp, EvidenceList } from "./components/Evidence";
import { Inspector } from "./components/Inspector";
import { Intelligence } from "./components/Intelligence";
type Screen = "workspace" | "inspector" | "intelligence";
export function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const view = location.hash.slice(1).split("/")[0];
    return ["workspace", "inspector", "intelligence"].includes(view)
      ? (view as Screen)
      : "workspace";
  });
  const [health, setHealth] = useState<ServerHealth>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<TaskDetail>();
  const selectedId = useRef<string | undefined>(
    location.hash.slice(1).split("/")[1],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const modalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!showSettings) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, textarea, a[href]",
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    const timer = setTimeout(() => focusable()[0]?.focus(), 0);
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowSettings(false);
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [showSettings]);
  const refresh = useCallback(async () => {
    try {
      const [h, t] = await Promise.all([
        api<ServerHealth>("/health"),
        api<TaskSummary[]>("/tasks"),
      ]);
      setHealth(h);
      setTasks(t);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const loadTask = useCallback(async (id: string, selection = false) => {
    if (selection) selectedId.current = id;
    try {
      const data = await api<TaskDetail>(`/tasks/${id}`);
      if (selectedId.current === id) setTask(data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!task || task.status !== "running") return;
    const timer = setInterval(() => {
      void loadTask(task.id);
      void refresh();
    }, 1200);
    return () => clearInterval(timer);
  }, [task?.id, task?.status, loadTask, refresh]);
  useEffect(() => {
    const id = location.hash.slice(1).split("/")[1];
    if (id) void loadTask(id);
  }, [loadTask]);
  useEffect(() => {
    history.replaceState(
      null,
      "",
      `#${screen}${task?.id || selectedId.current ? `/${task?.id || selectedId.current}` : ""}`,
    );
  }, [screen, task?.id]);
  async function select(id: string) {
    await loadTask(id, true);
    setScreen("workspace");
  }
  async function run(query?: string) {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/${task.id}/run`, query ? { query } : {});
      await loadTask(task.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportTask() {
    if (!task) return;
    try {
      const data = await api(`/tasks/${task.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `apilayer-${task.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const configured =
    health && Object.values(health.providers).filter(Boolean).length;
  const searchReady =
    health && (health.providers.exa || health.providers.tavily);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="APILayer home">
          <span className="brand-icon">
            <Layers3 size={21} />
          </span>
          API<span>Layer</span>
          <span className="beta">LAB</span>
        </a>
        <div className="space-label">RESEARCH CONTROL ROOM</div>
        <nav aria-label="Main navigation">
          {(
            [
              ["workspace", "Agent workspace", FileSearch],
              ["inspector", "Routing inspector", GitBranch],
              ["intelligence", "Provider intelligence", BarChart3],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-item ${screen === id ? "active" : ""}`}
              onClick={() => setScreen(id)}
            >
              <Icon size={18} />
              {label}
              {id === "inspector" && task?.events.length ? (
                <span className="nav-count">{task.events.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="side-heading">
          <span>RECENT RESEARCH</span>
          <button
            aria-label="New research"
            onClick={() => {
              selectedId.current = undefined;
              setTask(undefined);
              setScreen("workspace");
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="recent-list">
          {tasks.length ? (
            tasks.slice(0, 8).map((t) => (
              <button
                key={t.id}
                onClick={() => void select(t.id)}
                className={`recent-task ${task?.id === t.id ? "selected" : ""}`}
              >
                <span className={`status-dot ${t.status}`} />
                <span>{t.query}</span>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              Your research sessions will appear here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-tag">
            <ShieldCheck size={16} />
            <span>
              Server-side credentials
              <small>Local workspace · SQLite storage</small>
            </span>
          </div>
          <button
            className="settings-link"
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={16} />
            Connections & settings
            <ChevronRight size={14} />
          </button>
          <div className="profile">
            <div className="avatar">R</div>
            <span>
              Research workspace<small>Development environment</small>
            </span>
            <span className="status-dot complete" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace
            <ChevronRight size={13} />
            <span>
              {screen === "workspace"
                ? "Agent research"
                : screen === "inspector"
                  ? "Routing inspector"
                  : "Provider intelligence"}
            </span>
          </div>
          <div className="topbar-right">
            <span className={`connection ${configured ? "online" : ""}`}>
              <span className="status-dot" />
              {health
                ? `${configured} providers configured`
                : "Server disconnected"}
            </span>
            <button
              className="icon-button"
              title="Connections and settings"
              onClick={() => setShowSettings(true)}
            >
              <Settings2 size={17} />
            </button>
          </div>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {screen === "workspace" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> INTENT → EXECUTION → EVIDENCE
                  </div>
                  <h1>Research, with a clear trail.</h1>
                  <p>
                    Give your agent a goal. See every tool decision behind the
                    result.
                  </p>
                </div>
                <span className="version-tag">
                  DEMO V1 <span>•</span> LIVE APIS ONLY
                </span>
              </div>
              {!task ? (
                <IntentForm
                  health={health}
                  onCreate={async (body) => {
                    setBusy(true);
                    setError("");
                    try {
                      const t = await api("/tasks", body);
                      await loadTask(t.id, true);
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  busy={busy}
                  onSettings={() => setShowSettings(true)}
                />
              ) : (
                <>
                  <div className="session-heading">
                    <div>
                      <span className="mono muted">
                        SESSION / {task.id.slice(0, 8)}
                      </span>
                      <div className="session-title">
                        {task.intent.query}
                        <span className={`badge ${task.status}`}>
                          {task.status === "complete"
                            ? "Search complete"
                            : task.status}
                        </span>
                      </div>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => {
                        selectedId.current = undefined;
                        setTask(undefined);
                      }}
                    >
                      {" "}
                      <Plus size={15} />
                      New research
                    </button>
                  </div>
                  <div className="stats-grid">
                    <Stat
                      label="TASK BUDGET"
                      value={money(task.intent.budgetMicros)}
                      detail="User-approved spending cap"
                      icon={<ShieldCheck size={17} />}
                    />
                    <Stat
                      label="ESTIMATED SPEND"
                      value={money(task.spentMicros)}
                      detail={`${money(task.intent.budgetMicros - task.spentMicros - task.reservedMicros)} remaining · not a billed charge`}
                      icon={<Activity size={17} />}
                    />
                    <Stat
                      label="SOURCE EVIDENCE"
                      value={String(
                        new Set(task.sources.map((s) => s.url)).size,
                      ).padStart(2, "0")}
                      detail="Unique URLs returned by providers"
                      icon={<Globe2 size={17} />}
                    />
                    <Stat
                      label="VERIFIED ORGANIZATIONS"
                      value={`${task.organizations.length} / ${task.intent.requiredCount}`}
                      detail="Human-reviewed against every criterion"
                      icon={<CheckCircle2 size={17} />}
                    />
                  </div>
                  <div className="workspace-grid">
                    <div>
                      <section className="panel intent-summary">
                        <div className="panel-heading">
                          <span>
                            <Fingerprint size={17} />
                            Task intent
                          </span>
                          <span className="small-label">
                            VISIBLE BEFORE EXECUTION
                          </span>
                        </div>
                        <p>{task.intent.prompt}</p>
                        <div className="criteria-pills">
                          {task.intent.criteria.map((c) => (
                            <span key={c}>
                              <CircleDot size={12} />
                              {c}
                            </span>
                          ))}
                        </div>
                        {task.intent.queries &&
                          task.intent.queries.length > 1 && (
                            <details className="saved-plan">
                              <summary>
                                <GitBranch size={13} />
                                Research plan · {
                                  task.intent.queries.length
                                }{" "}
                                queries
                              </summary>
                              <ol>
                                {task.intent.queries.map((q, i) => (
                                  <li key={i}>{q}</li>
                                ))}
                              </ol>
                            </details>
                          )}
                        <div className="intent-meta">
                          <span>
                            {task.intent.mode === "compare"
                              ? "Compare both providers"
                              : "Automatic routing"}
                          </span>
                          <span>{task.intent.preference} policy</span>
                          <span>
                            {task.intent.domains.length
                              ? task.intent.domains.join(", ")
                              : "All public domains"}
                          </span>
                        </div>
                      </section>
                      <CompanyResults task={task} onError={setError} />
                      <section className="panel results-panel">
                        <div className="panel-heading">
                          <span>
                            <FileSearch size={17} />
                            Evidence workspace{" "}
                            <span className="count">{task.sources.length}</span>
                          </span>
                          <button
                            className="text-button"
                            onClick={() => setScreen("inspector")}
                          >
                            Inspect execution
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                        {task.sources.length ? (
                          <>
                            <div className="info-strip">
                              <ShieldCheck size={15} />
                              <span>
                                Returned sources are leads. Funding, activity,
                                and relevance stay unknown until you review
                                evidence.
                              </span>
                            </div>
                            <div className="source-list">
                              <EvidenceList
                                key={task.id}
                                task={task}
                                health={health}
                                onRefresh={() => loadTask(task.id)}
                                onError={setError}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="empty-state">
                            <div
                              className={`empty-icon ${task.status === "running" ? "pulsing" : ""}`}
                            >
                              {task.status === "running" ? (
                                <LoaderCircle className="spin" size={29} />
                              ) : (
                                <Search size={29} />
                              )}
                            </div>
                            <h3>
                              {task.status === "running"
                                ? "Searching real providers…"
                                : "Your evidence trail starts here"}
                            </h3>
                            <p>
                              {task.status === "failed"
                                ? "No sources returned. Open the inspector for the routing and provider outcomes."
                                : "Your intent is saved. Start a live search to route a query through a configured provider."}
                            </p>
                            {task.status !== "running" && (
                              <button
                                className="button primary"
                                disabled={busy || !searchReady}
                                onClick={() => void run()}
                              >
                                <Search size={15} />
                                Run live search
                                <ArrowRight size={15} />
                              </button>
                            )}
                          </div>
                        )}
                      </section>
                      {task.sources.length > 0 && (
                        <FollowUp
                          disabled={busy || task.status === "running"}
                          onRun={run}
                        />
                      )}
                    </div>
                    <div className="right-rail">
                      <section className="panel">
                        <div className="panel-heading">
                          <span>
                            <GitBranch size={17} />
                            Execution overview
                          </span>
                        </div>
                        <div className="rail-body">
                          <div className="rail-row">
                            <span>Policy version</span>
                            <code>{health?.policyVersion}</code>
                          </div>
                          <div className="rail-row">
                            <span>Paid attempts</span>
                            <b>
                              {
                                task.events.filter(
                                  (e) => e.type === "provider_request",
                                ).length
                              }
                            </b>
                          </div>
                          <div className="rail-row">
                            <span>Fallbacks considered</span>
                            <b>
                              {
                                task.events.filter(
                                  (e) => e.type === "fallback_triggered",
                                ).length
                              }
                            </b>
                          </div>
                          <div className="rail-row">
                            <span>Reserved</span>
                            <b>{money(task.reservedMicros)}</b>
                          </div>
                          <div className="budget-track">
                            <span
                              style={{
                                width: `${Math.min(100, ((task.spentMicros + task.reservedMicros) / task.intent.budgetMicros) * 100)}%`,
                              }}
                            />
                          </div>
                          <p className="tiny muted">
                            Charges are configurable rate-card estimates. Vendor
                            billing has not been reconciled.
                          </p>
                          <button
                            className="button secondary full"
                            disabled={
                              busy || task.status === "running" || !searchReady
                            }
                            onClick={() => void run()}
                          >
                            {task.status === "running" ? (
                              <LoaderCircle size={15} className="spin" />
                            ) : (
                              <Search size={15} />
                            )}{" "}
                            {task.status === "running"
                              ? "Research in progress"
                              : "Run search again"}
                          </button>
                          {task.status === "running" && (
                            <button
                              className="text-button stop-button"
                              onClick={() => {
                                void api(`/tasks/${task.id}/cancel`, {})
                                  .then(() => loadTask(task.id))
                                  .catch((e) => setError(e.message));
                              }}
                            >
                              <X size={12} />
                              Stop after current call
                            </button>
                          )}
                        </div>
                      </section>
                      <section className="panel">
                        <div className="panel-heading">
                          <span>
                            <Terminal size={16} />
                            Latest activity
                          </span>
                          <span className="live-dot" />
                        </div>
                        <div className="mini-trace">
                          {task.events
                            .slice(-5)
                            .reverse()
                            .map((e) => (
                              <div key={e.id}>
                                <span className="trace-dot" />
                                <span>
                                  {e.type.replaceAll("_", " ")}
                                  <small>
                                    {new Date(e.at).toLocaleTimeString()}{" "}
                                    {e.data.provider && `· ${e.data.provider}`}
                                  </small>
                                </span>
                              </div>
                            ))}
                        </div>
                      </section>
                      <div className="privacy-note">
                        <LockKeyhole size={16} />
                        <p>
                          {task.intent.consent
                            ? "This task contributes de-identified aggregates once cohort thresholds are met."
                            : "This task is excluded from provider analytics."}{" "}
                          Raw prompts and source content stay in the local
                          workspace.
                        </p>
                      </div>
                      <button
                        className="button secondary full"
                        onClick={() => void exportTask()}
                      >
                        <Download size={15} />
                        Export sanitized trace
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {screen === "inspector" && (
            <Inspector
              task={task}
              tasks={tasks}
              onSelect={(id) => loadTask(id, true)}
              onExport={exportTask}
            />
          )}
          {screen === "intelligence" && <Intelligence />}
          <footer>
            <span>
              <Layers3 size={13} />
              APILayer{" "}
              <span className="muted">/ Intent & tool intelligence</span>
            </span>
            <span>Observed execution. Estimated cost. Evaluated outcomes.</span>
          </footer>
        </main>
      </div>
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <section
            className="modal"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-heading">
              <h2 id="settings-title">Connections & settings</h2>
              <button
                aria-label="Close settings"
                onClick={() => setShowSettings(false)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="muted">
              Credentials are read from server environment variables. They are
              never sent to this browser.
            </p>
            {(["exa", "tavily", "firecrawl"] as const).map((p) => (
              <div key={p} className="provider-connection">
                <ProviderMark provider={p} />
                <div>
                  <strong>
                    {p === "exa"
                      ? "Exa"
                      : p === "tavily"
                        ? "Tavily"
                        : "Firecrawl"}
                  </strong>
                  <code>{p.toUpperCase()}_API_KEY</code>
                </div>
                <span
                  className={`badge ${health?.providers[p] ? "complete" : ""}`}
                >
                  {health?.providers[p] ? "Configured" : "Not configured"}
                </span>
              </div>
            ))}
            <div className="info-strip">
              <LockKeyhole size={18} />
              <span>
                Add keys to your server environment or .env file, then restart.
                “Configured” means a key is present; the first call verifies
                access.
              </span>
            </div>
            <label>
              Workspace access token
              <input
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Only if API_TOKEN is set on the server"
              />
            </label>
            <p className="tiny muted">
              Held in memory for this tab. Reloading clears it.
            </p>
            <button
              className="button primary full"
              onClick={() => {
                setToken(tokenInput);
                void refresh();
                if (selectedId.current) void loadTask(selectedId.current);
                setShowSettings(false);
              }}
            >
              Connect to workspace
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
