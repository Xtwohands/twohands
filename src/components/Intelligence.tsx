import { useEffect, useState } from "react";
import {
  Activity,
  BarChart03 as BarChart3,
  Fingerprint01 as Fingerprint,
  GitBranch01 as GitBranch,
  LayersThree01 as Layers3,
  Loading02 as LoaderCircle,
  Lock01 as LockKeyhole,
  SearchLg as Search,
  ShieldTick as ShieldCheck,
} from "@untitledui/icons";
import { api, money } from "../api";
import type { Analytics } from "../../server/analytics";
import { Stat, ProviderMark } from "./shared";

export function metric(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : String(value);
}

export function Intelligence() {
  const [data, setData] = useState<Analytics>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<Analytics>("/analytics")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> CROSS-PROVIDER OBSERVATIONS
          </div>
          <h1>A view beyond the API call.</h1>
          <p>
            Understand demand, routing conversion, and downstream evidence
            coverage.
          </p>
        </div>
        <span className="privacy-badge">
          <LockKeyhole size={13} />
          AGGREGATED & DE-IDENTIFIED
        </span>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        !error && (
          <div
            className="empty-state"
            role="status"
            aria-label="Loading provider analytics"
          >
            <LoaderCircle className="spin" />
          </div>
        )
      ) : data.suppressed ? (
        <>
          <div className="stats-grid">
            <Stat
              label="Consented tasks"
              value={String(data.cohortSize).padStart(2, "0")}
              detail="Only explicitly opted-in sessions"
              icon={<Fingerprint size={17} />}
            />
            <Stat
              label="Minimum cohort"
              value={String(data.minCohort).padStart(2, "0")}
              detail="Required before aggregate reporting"
              icon={<ShieldCheck size={17} />}
            />
            <Stat
              label="Provider insights"
              value="—"
              detail="Withheld until threshold is met"
              icon={<BarChart3 size={17} />}
            />
            <Stat
              label="Data source"
              value="Live only"
              detail="No seeded performance benchmarks"
              icon={<Activity size={17} />}
            />
          </div>
          <section className="panel analytics-empty">
            <div className="empty-state">
              <div className="empty-icon">
                <LockKeyhole size={30} />
              </div>
              <span className="small-label">Privacy threshold active</span>
              <h2>Real insights need a real cohort.</h2>
              <p>
                Complete at least {data.minCohort} opted-in research tasks to
                unlock provider analytics. Small provider cohorts are also
                withheld.
              </p>
              <div className="cohort-progress">
                {Array.from({ length: data.minCohort }, (_, i) => (
                  <span
                    key={i}
                    className={i < data.cohortSize ? "filled" : ""}
                  />
                ))}
              </div>
              <span className="mono muted">
                {data.cohortSize} / {data.minCohort} TASKS
              </span>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="stats-grid">
            <Stat
              label="Consented tasks"
              value={String(data.cohortSize)}
              detail="De-identified task cohort"
              icon={<Fingerprint size={17} />}
            />
            <Stat
              label="Search demand"
              value={metric(data.capabilities.search)}
              detail="Normalized research.search invocations"
              icon={<Search size={17} />}
            />
            <Stat
              label="Fallbacks considered"
              value={metric(data.fallbacks)}
              detail="Error or evidence coverage triggered"
              icon={<GitBranch size={17} />}
            />
            <Stat
              label="Opt-in comparisons"
              value={metric(data.comparisons)}
              detail="Same query, alternative live provider"
              icon={<Layers3 size={17} />}
            />
          </div>
          <section className="panel">
            <div className="panel-heading">
              <span>
                <BarChart3 size={17} />
                Competitive conversion & observed outcomes
              </span>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Provider conversion and outcomes"
            >
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Eligible / first selected</th>
                    <th>HTTP success</th>
                    <th>Avg latency</th>
                    <th>Coverage pass</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map((p) => (
                    <tr key={p.provider}>
                      <td>
                        <span className="table-provider">
                          <ProviderMark provider={p.provider} />
                          {p.provider}
                        </span>
                      </td>
                      {p.suppressed ? (
                        <td colSpan={5} className="muted">
                          Withheld · fewer than {data.minCohort} contributing
                          tasks
                        </td>
                      ) : (
                        <>
                          <td>
                            {metric(p.eligible)} / {metric(p.selected)}
                          </td>
                          <td>
                            {metric(p.httpSuccesses)} / {metric(p.calls)}
                          </td>
                          <td>
                            {p.latencyMs === null ? "—" : `${p.latencyMs} ms`}
                          </td>
                          <td>
                            {metric(p.coveragePasses)} /{" "}
                            {metric(p.coverageChecks)}
                          </td>
                          <td>
                            {p.estimatedMicros === null
                              ? "—"
                              : money(p.estimatedMicros)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="intelligence-cards">
            <section className="panel">
              <div className="panel-heading">Coverage & fallback outcomes</div>
              <div className="rail-body">
                <div className="rail-row">
                  <span>Insufficient evidence after HTTP 200</span>
                  <b>{metric(data.insufficient200)}</b>
                </div>
                <div className="rail-row">
                  <span>Coverage recovered after fallback</span>
                  <b>{metric(data.fallbackRecoveries)}</b>
                </div>
                <p className="tiny muted">
                  Observed coverage changes only; this does not establish
                  causation or prove company facts.
                </p>
              </div>
              <div className="panel-heading">Demand by capability</div>
              <div className="rail-body">
                {Object.entries(data.capabilities).map(([k, v]) => (
                  <div className="rail-row" key={k}>
                    <span>{k}</span>
                    <b>{metric(v as number | null)}</b>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">Budget & latency preferences</div>
              <div className="rail-body">
                {Object.entries(data.preferenceCounts).map(([k, v]) => (
                  <div className="rail-row" key={k}>
                    <span>{k}</span>
                    <b>{metric(v as number | null)}</b>
                  </div>
                ))}
                <p className="tiny muted">
                  Behavioral preference counts, not willingness-to-pay
                  estimates.
                </p>
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">Eligibility loss reasons</div>
              <div className="rail-body">
                {data.providers
                  .filter((p) => !p.suppressed)
                  .map((p) => (
                    <div key={p.provider}>
                      <b>{p.provider}</b>
                      {p.lossReasons.length ? (
                        p.lossReasons.map(([k, v]) => (
                          <p key={k} className="tiny muted">
                            {k}: {metric(v)}
                          </p>
                        ))
                      ) : (
                        <p className="tiny muted">
                          No eligibility exclusions recorded.
                        </p>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          </div>
          <div className="info-strip">
            <ShieldCheck size={17} />
            {data.note}
          </div>
        </>
      )}
      {data?.suppressed && (
        <div className="intelligence-cards">
          {[
            [
              "Routing conversion",
              "When was a provider eligible, selected, or excluded?",
            ],
            [
              "Evidence quality gaps",
              "Where did a technically successful search leave insufficient evidence?",
            ],
            [
              "Demand & constraints",
              "Which capabilities and explicit spending preferences recur?",
            ],
          ].map(([title, desc], i) => (
            <section key={title} className="insight-preview">
              <span className="mono">0{i + 1} / INSIGHT</span>
              <h3>{title}</h3>
              <p>{desc}</p>
              <span>
                <LockKeyhole size={12} />
                Awaiting consented observations
              </span>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
