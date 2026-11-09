import {
  ArrowRight,
  ArrowUpRight,
  BarChartSquare02,
  FileCheck02,
  Link01,
  RefreshCw01,
} from "@untitledui/icons";
import type { CompanyInsights, ToolCompany } from "../server/company-types";
import { capabilityData } from "../server/provider-capability-data";
import { providerTools } from "../server/provider-identifiers";
import type { ProviderId } from "../server/types";
import { providerLogos } from "./components/ToolOptions";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Panel, InlineError } from "./observation-ui";
import "./company-dashboard.css";

const sections = [
  ["overview", "Overview"],
  ["activity", "Live usage"],
  ["benchmarks", "Controlled tests"],
  ["plans", "Test plans"],
  ["integration", "Integration"],
] as const;
export function companyDashboardSection(section: string) {
  return sections.some(([id]) => id === section) ? section : "overview";
}
export function companyDashboardLinks(
  id: string,
  section: string,
  registered: boolean,
  canManage: boolean,
) {
  return [
    ...sections.map(([value, label]) => ({
      href: `#company/${id}/${value}`,
      label,
      selected: section === value,
    })),
    ...(registered
      ? [
          {
            href: `#company/${id}/details`,
            label: "Company details",
            selected: section === "details",
          },
        ]
      : []),
    ...(registered && canManage
      ? [
          {
            href: `#company/${id}/team`,
            label: "Company team",
            selected: section === "team",
          },
        ]
      : []),
  ];
}
function EmptySection({
  title,
  children,
  icon = "usage",
}: {
  title: string;
  children: React.ReactNode;
  icon?: "usage" | "test" | "plan";
}) {
  const Icon =
    icon === "usage"
      ? BarChartSquare02
      : icon === "test"
        ? FileCheck02
        : Link01;
  return (
    <div className="company-dashboard-empty">
      <Icon aria-hidden="true" />
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}
function Usage({
  insights,
  loading,
  restricted,
}: {
  insights?: CompanyInsights;
  loading: boolean;
  restricted: boolean;
}) {
  const m =
    insights?.status === "available" &&
    insights.metrics &&
    insights.metrics.calls > 0
      ? insights.metrics
      : null;
  if (loading && !insights) return <p role="status">Loading recorded usage…</p>;
  if (!m)
    return (
      <EmptySection
        title={
          insights?.status === "available" && !restricted
            ? "No usage yet"
            : "No usage available yet"
        }
      >
        Recorded activity will appear here when it’s available.
      </EmptySection>
    );
  return (
    <>
      <div className="company-funnel">
        {[
          ["Offered to agents", m.offeredSessions],
          ["Used in a session", m.selectedSessions],
        ].map(([label, value]) => (
          <div className="company-funnel-row" key={label}>
            <div>
              <span>{label}</span>
              <strong>{Number(value).toLocaleString()}</strong>
            </div>
            <div className="company-bar-track">
              <span
                style={{
                  width: `${Math.min(100, m.offeredSessions ? (Number(value) / m.offeredSessions) * 100 : 0)}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="company-call-summary">
        <span>
          <strong>{m.calls.toLocaleString()}</strong> completed calls
        </span>
        <span>
          <strong>{m.successfulCalls.toLocaleString()}</strong> successful calls
        </span>
      </div>
    </>
  );
}
function ControlledTests() {
  return (
    <EmptySection title="No controlled tests yet" icon="test">
      Completed tests and their evidence will appear here when they’re available
      to your company.
    </EmptySection>
  );
}
function TestPlans() {
  return (
    <EmptySection title="No test plans yet" icon="plan">
      Planning data runs will be added later. No runs have been scheduled.
    </EmptySection>
  );
}
export function CompanyDashboard({
  id,
  name,
  providerId,
  company,
  section,
  insights,
  loading,
  error,
  refresh,
  companies = [],
}: {
  id: string;
  name: string;
  providerId: ProviderId | null;
  company?: ToolCompany;
  section: string;
  insights?: CompanyInsights;
  loading: boolean;
  error: string;
  refresh: () => void;
  companies?: Pick<ToolCompany, "id" | "name">[];
}) {
  const tool = Object.entries(providerTools).find(
    ([, provider]) => provider === providerId,
  )?.[0] as keyof typeof capabilityData | undefined;
  const capability = tool ? capabilityData[tool] : undefined;
  const tab = companyDashboardSection(section);
  const metrics = insights?.status === "available" ? insights.metrics : null;
  const restricted =
    !!company && (company.status !== "approved" || !company.insightsEnabled);
  const status = company
    ? {
        pending: "Under review",
        approved: "Approved",
        rejected: "Changes requested",
        suspended: "Access suspended",
      }[company.status]
    : "Provider preview";
  const statusNote =
    company?.status === "pending"
      ? "Company review pending"
      : insights?.status === "awaiting_release"
        ? "Shared data access pending"
        : "";
  const percent = (value: number, total: number) =>
    total ? `${Math.round((value / total) * 100)}%` : "—";
  const Integration = ({ full = false }: { full?: boolean }) => (
    <div className="company-capability">
      <code>{tool || company?.toolName || "Integration not linked"}</code>
      <p>
        {capability?.description ||
          company?.description ||
          "Your tool’s description and supported operations will appear here."}
      </p>
      {capability && (
        <>
          <strong>When agents use it</strong>
          <p>{capability.useWhen}</p>
          <a
            href={capability.documentationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Provider documentation <ArrowUpRight />
          </a>
          {full && (
            <>
              <h3 className="company-dashboard-subheading">Request defaults</h3>
              <dl className="company-dashboard-defaults">
                {Object.entries(capability.adapter).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
              <details className="company-dashboard-limitations">
                <summary>Integration limitations</summary>
                <p>{capability.limitations}</p>
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
  return (
    <div className="provider-page company-page company-dashboard">
      <div className="page-heading company-heading">
        <div>
          <div className="company-title">
            {providerId && (
              <img
                className={`company-logo company-logo-${providerId}`}
                src={providerLogos[providerId]}
                alt=""
                width={32}
                height={32}
              />
            )}
            <h1>{name} dashboard</h1>
          </div>
          <p>Understand how agents discover, use, and evaluate your tool.</p>
        </div>
        <div className="company-dashboard-actions">
          {companies.length > 1 && (
            <label className="company-dashboard-company">
              Company
              <select
                aria-label="Current company"
                value={id}
                onChange={(e) => {
                  location.hash = `company/${e.target.value}/${tab}`;
                }}
              >
                {companies.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Badge variant="outline">{status}</Badge>
          <Button
            variant="outline"
            onClick={refresh}
            aria-label="Refresh company dashboard"
          >
            <RefreshCw01 />
            Refresh
          </Button>
        </div>
      </div>
      <InlineError message={error} />
      {statusNote && (
        <p className="company-dashboard-context">
          {statusNote}
          {company && (
            <>
              {" "}
              · <a href={`#company/${id}/details`}>View company details</a>
            </>
          )}
        </p>
      )}
      {tab === "overview" && (
        <>
          <div className="company-metric-grid">
            {[
              [
                "Selected when offered",
                metrics
                  ? percent(metrics.selectedSessions, metrics.offeredSessions)
                  : "—",
                metrics
                  ? `${metrics.selectedSessions.toLocaleString()} of ${metrics.offeredSessions.toLocaleString()} sessions`
                  : "No usage available yet",
              ],
              [
                "Requests succeeded",
                metrics ? percent(metrics.successfulCalls, metrics.calls) : "—",
                metrics
                  ? `${metrics.successfulCalls.toLocaleString()} of ${metrics.calls.toLocaleString()} completed calls`
                  : "No completed requests available",
              ],
              [
                "Sessions using your tool",
                metrics ? metrics.selectedSessions.toLocaleString() : "—",
                "Recorded agent selections",
              ],
              [
                "Completed requests",
                metrics ? metrics.calls.toLocaleString() : "—",
                "Organic tool activity",
              ],
            ].map(([label, value, detail]) => (
              <div className="company-metric" key={label}>
                <h2>{label}</h2>
                <strong>{value}</strong>
                <p>{detail}</p>
              </div>
            ))}
          </div>
          <div className="company-main-grid">
            <Panel
              title="From discovery to use"
              description="Recorded organic activity"
              action={
                <a
                  className="company-dashboard-card-link"
                  href={`#company/${id}/activity`}
                  aria-label="View live usage"
                >
                  <ArrowUpRight />
                </a>
              }
            >
              <Usage
                insights={insights}
                loading={loading}
                restricted={restricted}
              />
            </Panel>
            <Panel
              title="What the agent sees"
              description="Your tool’s current description and capabilities"
              action={
                <a
                  className="company-dashboard-card-link"
                  href={`#company/${id}/integration`}
                  aria-label="View integration"
                >
                  <ArrowUpRight />
                </a>
              }
            >
              <Integration />
            </Panel>
          </div>
          <div className="company-main-grid">
            <Panel
              title="Controlled tests"
              description="Execution and evidence from controlled comparisons"
              action={
                <a
                  className="company-dashboard-card-link"
                  href={`#company/${id}/benchmarks`}
                  aria-label="View controlled tests"
                >
                  <ArrowUpRight />
                </a>
              }
            >
              <ControlledTests />
            </Panel>
            <Panel
              title="Test plans"
              description="A place to track what you want to learn next"
              action={
                <a
                  className="company-dashboard-card-link"
                  href={`#company/${id}/plans`}
                  aria-label="View test plans"
                >
                  <ArrowUpRight />
                </a>
              }
            >
              <TestPlans />
            </Panel>
          </div>
          <Panel
            title="What to review next"
            description="Start with your integration, then use evidence to guide changes."
          >
            <div className="company-dashboard-review">
              {[
                [
                  "Describe the right use case",
                  "Check that agents can tell when your tool fits the task.",
                  "integration",
                ],
                [
                  "Understand actual selection",
                  "Review discovery and usage together as activity becomes available.",
                  "activity",
                ],
                [
                  "Compare a measured baseline",
                  "Keep test cases and evaluation criteria consistent across changes.",
                  "benchmarks",
                ],
              ].map(([title, detail, destination]) => (
                <a href={`#company/${id}/${destination}`} key={title}>
                  <div>
                    <strong>{title}</strong>
                    <p>{detail}</p>
                  </div>
                  <ArrowRight />
                </a>
              ))}
            </div>
          </Panel>
        </>
      )}
      {tab === "activity" && (
        <Panel
          title="Live usage"
          description="Recorded organic activity for your tool"
        >
          <Usage
            insights={insights}
            loading={loading}
            restricted={restricted}
          />
        </Panel>
      )}
      {tab === "benchmarks" && (
        <>
          <Panel
            title="Controlled tests"
            description="Compare execution, response time, and returned evidence"
          >
            <ControlledTests />
          </Panel>
          <Panel title="Keep comparisons useful">
            <div className="company-dashboard-method">
              <div>
                <strong>Use the same cases</strong>
                <p>Compare like-for-like tasks and settings.</p>
              </div>
              <div>
                <strong>Review the evidence</strong>
                <p>
                  A successful request alone does not measure answer quality.
                </p>
              </div>
              <div>
                <strong>Document the change</strong>
                <p>Make the baseline and follow-up easy to compare.</p>
              </div>
            </div>
          </Panel>
        </>
      )}
      {tab === "plans" && (
        <Panel
          title="Test plans"
          description="Document a hypothesis, a change, and a way to measure it"
        >
          <TestPlans />
        </Panel>
      )}
      {tab === "integration" && (
        <Panel
          title="What the agent sees"
          description="Current tool metadata and request defaults"
        >
          <Integration full />
        </Panel>
      )}
    </div>
  );
}
