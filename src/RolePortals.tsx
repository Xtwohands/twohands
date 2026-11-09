import { AdminNavigation } from "./AdminNavigation";
import { CompanyTeamView } from "./CompanyTeamView";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Settings01, Menu01, XClose } from "@untitledui/icons";
import { useAccount, AccountControls } from "./AccountGate";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Panel, InlineError, date } from "./observation-ui";
import type {
  ToolCompany,
  CompanyInsights,
  CompanyReviewItem,
  CompanyPreviewTarget,
} from "../server/company-types";
import "./roles.css";
export function PortalShell({
  area,
  title,
  links,
  adminPage = "admin",
  children,
}: {
  area: "company" | "admin" | "settings";
  title: string;
  links: { href: string; label: string; selected: boolean }[];
  children: ReactNode;
  adminPage?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (area !== "admin") return;
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    window.addEventListener("popstate", close);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("popstate", close);
    };
  }, [area]);
  const nav = (
    <>
      <a href="#home" className="obs-brand">
        <img src="/octolab.svg" width="32" height="32" alt="" />
        octolab
      </a>
      <div className="portal-area">
        {area === "settings"
          ? "Account"
          : area === "company"
            ? "Tool company"
            : "Administration"}
      </div>
      <nav
        aria-label={
          area === "settings"
            ? "Settings navigation"
            : area === "company"
              ? "Tool company navigation"
              : "Admin navigation"
        }
      >
        {area === "admin" ? (
          <AdminNavigation page={adminPage} onNavigate={() => setOpen(false)} />
        ) : (
          links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={link.selected ? "selected" : ""}
              aria-current={link.selected ? "page" : undefined}
            >
              {link.label}
            </a>
          ))
        )}
      </nav>
      <div className="sidebar-bottom">
        <a href="#settings">
          <Settings01 />
          Settings
        </a>
        <AccountControls showWorkspace={false} />
      </div>
    </>
  );
  return (
    <div className="observation-shell dark role-portal">
      <a
        className="skip-link"
        href="#portal-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("portal-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="obs-sidebar">{nav}</aside>
      <div className="obs-body">
        <header className="obs-topbar">
          <Button
            variant="ghost"
            size="icon"
            className="mobile-nav-button"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <XClose /> : <Menu01 />}
          </Button>
          <span>{title}</span>
        </header>
        {open && <div className="portal-mobile-nav">{nav}</div>}
        <main className="obs-main" id="portal-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
const statusLabels = {
  pending: "Under review",
  approved: "Approved",
  rejected: "Changes requested",
  suspended: "Access suspended",
};
export function CompanyPortal(props: { id?: string; section: string }) {
  const account = useAccount();
  const target = account.profile?.companyPreview;
  if (target && props.id && props.id !== target.id)
    return (
      <PortalShell area="company" title="Company preview" links={[]}>
        <Panel title="Choose a company from the preview selector">
          <p>This page is outside the company you’re previewing.</p>
        </Panel>
      </PortalShell>
    );
  return target?.kind === "provider" ? (
    <IntegratedProviderPreview key={target.target} target={target} />
  ) : (
    <RegisteredCompanyPortal {...props} />
  );
}
function InsightValues({
  insights,
  error,
}: {
  insights?: CompanyInsights;
  error?: string;
}) {
  if (error) return <InlineError message={error} />;
  if (!insights) return <p role="status">Loading live insights…</p>;
  if (insights.status === "awaiting_release")
    return (
      <p>
        Your integration is approved. Aggregate data access is awaiting review.
      </p>
    );
  if (insights.status === "insufficient_data")
    return (
      <p>
        No report available yet. At least {insights.minimumCohort} independent
        workspaces must contribute eligible usage before metrics appear.
      </p>
    );
  if (!insights.metrics) return <p>No recorded metrics are available.</p>;
  const labels: Record<string, string> = {
    offeredSessions: "Sessions offered your tool",
    selectedSessions: "Sessions using your tool",
    calls: "Completed calls",
    successfulCalls: "Successful calls",
  };
  return (
    <div className="summary-grid">
      {Object.entries(insights.metrics).map(([key, value]) => (
        <div key={key}>
          <span>{labels[key]}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
function IntegratedProviderPreview({
  target,
}: {
  target: CompanyPreviewTarget;
}) {
  const [insights, setInsights] = useState<CompanyInsights>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const value = await api<CompanyInsights>("/auth/preview-insights");
        if (active) {
          setInsights(value);
          setError("");
        }
      } catch (e) {
        if (active) {
          setInsights(undefined);
          setError((e as Error).message);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [target.target]);
  return (
    <PortalShell
      area="company"
      title={target.name}
      links={[
        {
          href: `#company/${target.id}/insights`,
          label: "Tool insights",
          selected: true,
        },
      ]}
    >
      <div className="page-heading">
        <div>
          <h1>{target.name} tool insights</h1>
          <p>Live recorded activity for this integrated provider.</p>
        </div>
      </div>
      <Panel
        title="Integrated provider"
        description="No company registration or owner account has been created for this integration."
        action={<span className="portal-status">Unregistered</span>}
      >
        <p>
          This is a read-only provider preview. It does not verify a company or
          grant membership. Metrics use recorded organic activity and the same
          privacy thresholds as company dashboards.
        </p>
      </Panel>
      <Panel
        title="Your tool’s performance"
        description="Live aggregate activity across eligible workspaces. Customer prompts, outputs, and individual sessions are never included."
      >
        <InsightValues insights={insights} error={error} />
      </Panel>
    </PortalShell>
  );
}
function RegisteredCompanyPortal({
  id,
  section,
}: {
  id?: string;
  section: string;
}) {
  const account = useAccount();
  const companies = account.profile?.companies ?? [];
  const selected = companies.find((c) => c.id === id) ?? companies[0];
  const [editing, setEditing] = useState(false);
  const registering = id === "new" || !companies.length || editing;
  const [company, setCompany] = useState<ToolCompany | undefined>(selected);
  const [insights, setInsights] = useState<CompanyInsights>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    website: "",
    toolName: "",
    description: "",
  });
  const requestKey = useRef(crypto.randomUUID());
  const tab =
    section === "team"
      ? "team"
      : section === "insights"
        ? "insights"
        : "overview";
  const canManage =
    company?.role === "owner" || company?.role === "platform_admin";
  useEffect(() => {
    let active = true;
    setError("");
    setInsights(undefined);
    if (registering || !selected) return;
    setCompany(selected);
    const refresh = async () => {
      try {
        const value = await api<ToolCompany>(`/companies/${selected.id}`);
        if (!active) return;
        setCompany(value);
        if (value.status === "approved" && tab === "insights") {
          const data = await api<CompanyInsights>(
            `/companies/${value.id}/insights`,
          );
          if (active) setInsights(data);
        }
      } catch (e) {
        if (active) {
          setCompany(undefined);
          setInsights(undefined);
          setError((e as Error).message);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.id, registering, tab]);
  const links = registering
    ? [{ href: "#company/new", label: "Register company", selected: true }]
    : [
        {
          href: `#company/${selected!.id}/overview`,
          label: "Overview",
          selected: tab === "overview",
        },
        {
          href: `#company/${selected!.id}/insights`,
          label: "Tool insights",
          selected: tab === "insights",
        },
        ...(canManage
          ? [
              {
                href: `#company/${selected!.id}/team`,
                label: "Company team",
                selected: tab === "team",
              },
            ]
          : []),
        ...(!account.previewRole
          ? [
              {
                href: "#company/new",
                label: "Register another company",
                selected: false,
              },
            ]
          : []),
      ];
  return (
    <PortalShell
      area="company"
      title={
        registering ? "Company registration" : (company?.name ?? "Tool company")
      }
      links={links}
    >
      <div className="page-heading">
        <div>
          <h1>
            {registering
              ? editing
                ? "Update company details"
                : "Bring your tool to octolab"
              : tab === "team"
                ? "Company team"
                : tab === "insights"
                  ? "Tool insights"
                  : (company?.name ?? "Company overview")}
          </h1>
          <p>
            {registering
              ? "Register your company so our team can verify ownership and arrange your integration."
              : "Manage your company’s integration and access to aggregate tool performance."}
          </p>
        </div>
      </div>
      <InlineError message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {registering ? (
        <Panel
          title="Company details"
          description="Registration does not claim an existing provider or enable its data."
        >
          <form
            className="portal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const value =
                  editing && selected
                    ? await api<ToolCompany>(
                        `/companies/${selected.id}/resubmit`,
                        { ...form, revision: company!.revision },
                      )
                    : await api<ToolCompany>("/auth/companies", {
                        ...form,
                        requestKey: requestKey.current,
                      });
                await account.refresh();
                setEditing(false);
                requestKey.current = crypto.randomUUID();
                location.hash = `company/${value.id}/overview`;
                setNotice(
                  "Registration submitted. You can track its review here.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Company name
              <Input
                required
                minLength={2}
                maxLength={80}
                autoComplete="organization"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Company website
              <Input
                required
                type="url"
                placeholder="https://yourcompany.com"
                maxLength={300}
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
              />
            </label>
            <label>
              Tool name
              <Input
                required
                minLength={2}
                maxLength={80}
                value={form.toolName}
                onChange={(e) => setForm({ ...form, toolName: e.target.value })}
              />
            </label>
            <label>
              What does your tool do?
              <Textarea
                required
                minLength={20}
                maxLength={1500}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <Button type="submit" disabled={busy}>
              {busy
                ? "Submitting…"
                : editing
                  ? "Resubmit for review"
                  : "Submit for review"}
              <ArrowRight size={16} />
            </Button>
          </form>
          {editing && (
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Back to company
            </Button>
          )}
        </Panel>
      ) : (
        company && (
          <>
            {companies.length > 1 && (
              <label className="portal-company-select">
                Company
                <select
                  aria-label="Current company"
                  value={selected!.id}
                  onChange={(e) =>
                    (location.hash = `company/${e.target.value}/overview`)
                  }
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tab === "team" ? (
              canManage ? (
                <CompanyTeamView key={company.id} companyId={company.id} />
              ) : (
                <Panel title="Company owner access required">
                  <p>
                    Only a company owner can manage the team and review access
                    history.
                  </p>
                </Panel>
              )
            ) : tab === "overview" ? (
              <>
                <Panel
                  title="Integration status"
                  action={
                    <span className="portal-status">
                      {statusLabels[company.status]}
                    </span>
                  }
                >
                  {canManage &&
                    ["pending", "rejected"].includes(company.status) && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setForm({
                            name: company.name,
                            website: company.website,
                            toolName: company.toolName,
                            description: company.description,
                          });
                          setEditing(true);
                        }}
                      >
                        Update registration
                      </Button>
                    )}
                  <ol className="portal-steps">
                    <li>
                      <strong>Company registered</strong>
                      <p>Submitted {date(company.createdAt)}.</p>
                    </li>
                    <li>
                      <strong>Ownership and integration review</strong>
                      <p>
                        {company.status === "pending"
                          ? "Our team checks your website, ownership, and tool requirements. Your registration is waiting for review."
                          : company.feedback || statusLabels[company.status]}
                      </p>
                    </li>
                    <li>
                      <strong>Tool connected</strong>
                      <p>
                        {company.status === "approved"
                          ? `Your company is linked to ${company.providerId}.`
                          : "An administrator links the verified integration after approval."}
                      </p>
                    </li>
                    <li>
                      <strong>Aggregate insights</strong>
                      <p>
                        {company.insightsEnabled
                          ? "Enabled. Metrics appear once enough independent usage is available."
                          : "Available after approval and a separate data-access review."}
                      </p>
                    </li>
                  </ol>
                </Panel>
                <Panel title="Company profile">
                  <dl className="portal-details">
                    <dt>Website</dt>
                    <dd>
                      <a
                        href={company.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {company.website}
                      </a>
                    </dd>
                    <dt>Tool</dt>
                    <dd>{company.toolName}</dd>
                    <dt>Description</dt>
                    <dd>{company.description}</dd>
                  </dl>
                </Panel>
              </>
            ) : (
              <Panel
                title="Your tool’s performance"
                description="Aggregate activity across eligible workspaces. Customer prompts, outputs, and individual sessions are never included."
              >
                {company.status !== "approved" ? (
                  <p>
                    Insights will become available after your company and
                    integration are approved.
                  </p>
                ) : (
                  <InsightValues insights={insights} />
                )}
              </Panel>
            )}
          </>
        )
      )}
    </PortalShell>
  );
}
export function AdminCompanyReview() {
  const account = useAccount();
  const [items, setItems] = useState<CompanyReviewItem[]>([]),
    [selected, setSelected] = useState<CompanyReviewItem>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("pending");
  const [form, setForm] = useState({
    status: "approved",
    providerId: "",
    insightsEnabled: false,
    feedback: "",
  });
  const [history, setHistory] = useState<
    {
      actorId: string;
      at: string;
      revision: number;
      data: Record<string, unknown>;
    }[]
  >([]);
  const [cursor, setCursor] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const selectionVersion = useRef(0);
  const queuePath = `/admin/companies?status=${filter}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
  const refresh = async () => {
    const data = await api<{
      items: CompanyReviewItem[];
      nextCursor: string | null;
    }>(queuePath);
    setItems(data.items);
    setNextCursor(data.nextCursor);
  };
  useEffect(() => {
    let active = true;
    api<{ items: CompanyReviewItem[]; nextCursor: string | null }>(queuePath)
      .then((data) => {
        if (active) {
          setItems(data.items);
          setNextCursor(data.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [queuePath]);
  const select = async (item: CompanyReviewItem) => {
    const version = ++selectionVersion.current;
    setSelected(item);
    setError("");
    setForm({
      status: item.status === "pending" ? "approved" : item.status,
      providerId: item.providerId ?? "",
      insightsEnabled: item.insightsEnabled,
      feedback: item.feedback,
    });
    setHistory([]);
    try {
      const data = await api<typeof history>(
        `/admin/companies/${item.id}/history`,
      );
      if (version === selectionVersion.current) setHistory(data);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <PortalShell area="admin" title="Administration" links={[]}>
      <div className="page-heading">
        <div>
          <h1>Company reviews</h1>
          <p>
            Verify tool company ownership, link integrations, and control access
            to aggregate insights.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          Refresh reviews
        </Button>
      </div>
      <InlineError message={error} />
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!account.profile?.workspaces.length && (
        <Panel title="Workspace operations">
          <p>
            There are no customer workspaces yet. Company review works
            independently; customer activity and disputes appear once a
            workspace exists.
          </p>
        </Panel>
      )}
      <label className="portal-company-select">
        Review status
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setCursor("");
            setSelected(undefined);
            selectionVersion.current++;
          }}
        >
          <option value="pending">Pending</option>
          <option value="all">All companies</option>
          <option value="approved">Approved</option>
          <option value="rejected">Changes requested</option>
          <option value="suspended">Suspended</option>
        </select>
      </label>
      <div className="portal-review-grid">
        <Panel title="Registered companies">
          <div className="portal-company-list">
            {items
              .filter((i) => filter === "all" || i.status === filter)
              .map((item) => (
                <button
                  key={item.id}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => void select(item)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.toolName} · {statusLabels[item.status]}
                  </span>
                </button>
              ))}
            {!items.some((i) => filter === "all" || i.status === filter) && (
              <p>No companies in this queue.</p>
            )}
          </div>
          <div className="account-actions">
            {cursor && (
              <Button variant="outline" onClick={() => setCursor("")}>
                First page
              </Button>
            )}
            {nextCursor && (
              <Button variant="outline" onClick={() => setCursor(nextCursor)}>
                Next page
              </Button>
            )}
          </div>
        </Panel>
        <Panel
          title={selected ? `Review ${selected.name}` : "Select a company"}
        >
          {selected ? (
            <>
              <dl className="portal-details">
                <dt>Applicant</dt>
                <dd>{selected.ownerEmail}</dd>
                <dt>Website</dt>
                <dd>
                  <a href={selected.website} target="_blank" rel="noreferrer">
                    {selected.website}
                  </a>
                </dd>
                <dt>Tool</dt>
                <dd>{selected.toolName}</dd>
                <dt>Description</dt>
                <dd>{selected.description}</dd>
              </dl>
              <form
                className="portal-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError("");
                  try {
                    await api(`/admin/companies/${selected.id}/review`, {
                      ...form,
                      providerId: form.providerId || null,
                      revision: selected.revision,
                    });
                    await refresh();
                    setSelected(undefined);
                    setNotice(
                      "Company review saved. The owner will see your feedback.",
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Decision
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        status: e.target.value,
                        insightsEnabled: false,
                      })
                    }
                  >
                    <option value="approved">Approve</option>
                    <option value="rejected">Request changes</option>
                    <option value="suspended">Suspend access</option>
                  </select>
                </label>
                <label>
                  Verified provider integration
                  <select
                    value={form.providerId}
                    required={form.status === "approved"}
                    onChange={(e) =>
                      setForm({ ...form, providerId: e.target.value })
                    }
                  >
                    <option value="">Choose an integration</option>
                    <option value="exa">Exa</option>
                    <option value="tavily">Tavily</option>
                    <option value="firecrawl">Firecrawl</option>
                  </select>
                </label>
                <label className="portal-checkbox">
                  <input
                    type="checkbox"
                    disabled={form.status !== "approved"}
                    checked={form.insightsEnabled}
                    onChange={(e) =>
                      setForm({ ...form, insightsEnabled: e.target.checked })
                    }
                  />
                  Release aggregate insights after ownership review
                </label>
                <label>
                  Feedback to company
                  <Textarea
                    required
                    minLength={5}
                    maxLength={1500}
                    value={form.feedback}
                    onChange={(e) =>
                      setForm({ ...form, feedback: e.target.value })
                    }
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save review"}
                </Button>
              </form>
              <details className="portal-audit">
                <summary>Review history</summary>
                {history.map((event) => (
                  <div key={event.revision}>
                    <strong>
                      {event.revision === 0
                        ? "Registration submitted"
                        : String(event.data.status)}
                    </strong>
                    <p>
                      {date(event.at)} · {event.actorId}
                    </p>
                    {typeof event.data.feedback === "string" && (
                      <p>{event.data.feedback}</p>
                    )}
                  </div>
                ))}
              </details>
            </>
          ) : (
            <p>
              Open a registration to verify the company and review its
              integration.
            </p>
          )}
        </Panel>
      </div>
    </PortalShell>
  );
}

export function AccountSettings() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const canPreview = account.profile?.canPreview || account.profile?.isAdmin;
  const current =
    account.previewRole || (account.profile?.isAdmin ? "admin" : "user");
  const [experience, setExperience] = useState(current);
  const [target, setTarget] = useState(account.previewTarget || "");
  const selectedTarget = target || account.previewTargets[0]?.target || "";
  const destination =
    current === "company"
      ? "#company"
      : current === "admin"
        ? "#admin"
        : "#dashboard";
  return (
    <PortalShell
      area="settings"
      title="Settings"
      links={[
        {
          href: destination,
          label:
            "Back to " +
            (current === "company"
              ? "company"
              : current === "admin"
                ? "administration"
                : "dashboard"),
          selected: false,
        },
      ]}
    >
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Manage your account and product access.</p>
        </div>
      </div>
      {canPreview && (
        <Panel
          title="Preview as"
          description="Preview a company’s owner experience or your user experience. Your admin identity stays intact; other administrator actions are disabled during preview."
        >
          <label className="settings-preview-field">
            Experience
            <select
              aria-label="Preview as"
              value={experience}
              disabled={busy}
              onChange={async (e) => {
                const value = e.target.value;
                setExperience(value);
                if (value === "company") return;
                setBusy(true);
                try {
                  await account.preview(value === "admin" ? null : "user");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <option value="admin">Administrator</option>
              <option value="user">User</option>
              <option value="company">Tool company</option>
            </select>
          </label>
          {experience === "company" && (
            <div className="settings-company-preview">
              <label className="settings-preview-field">
                Company to preview
                <select
                  aria-label="Company to preview"
                  value={selectedTarget}
                  disabled={busy || !account.previewTargets.length}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {!account.previewTargets.length && (
                    <option value="">Loading companies…</option>
                  )}
                  <optgroup label="Registered companies">
                    {account.previewTargets
                      .filter((item) => item.kind === "company")
                      .map((item) => (
                        <option key={item.target} value={item.target}>
                          {item.name} ·{" "}
                          {statusLabels[item.status as ToolCompany["status"]]}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Integrated providers">
                    {account.previewTargets
                      .filter((item) => item.kind === "provider")
                      .map((item) => (
                        <option key={item.target} value={item.target}>
                          {item.name} · unregistered
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <InlineError message={account.previewTargetError} />
              {account.previewTargetError && (
                <Button
                  variant="outline"
                  onClick={() => void account.reloadPreviewTargets()}
                >
                  Reload companies
                </Button>
              )}
              <Button
                disabled={busy || !selectedTarget}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await account.preview("company", selectedTarget);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Open company preview
                <ArrowRight />
              </Button>
            </div>
          )}
        </Panel>
      )}
      <Panel title="Account" description={account.profile?.user.email}>
        <div className="settings-account-links">
          {account.previewRole !== "company" && (
            <a href="#dashboard">
              My dashboard <ArrowRight size={16} />
            </a>
          )}
          <a href="#company">
            My tool company <ArrowRight size={16} />
          </a>
        </div>
        <AccountControls
          showIdentity={false}
          showWorkspace={account.previewRole !== "company"}
        />
      </Panel>
    </PortalShell>
  );
}
