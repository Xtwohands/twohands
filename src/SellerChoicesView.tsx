import { useEffect, useState } from "react";
import type { SellerReport } from "../server/seller-report";
import type { ProviderId } from "../server/types";
import { api, money } from "./api";
import { Panel, InlineError } from "./observation-ui";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

type Row = { key: string; label: string; count: number };
const percent = (v: number | null) =>
  v === null ? "—" : `${Math.round(v * 100)}%`;

function Bars({ rows, empty }: { rows: Row[]; empty: string }) {
  const most = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <p className="choices-empty">{empty}</p>;
  return (
    <ul className="choices-bars">
      {rows.map((r) => (
        <li key={r.key}>
          <div>
            <span>{r.label}</span>
            <strong>{r.count}</strong>
          </div>
          <span className="choices-track">
            <span style={{ width: `${(r.count / most) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SellerChoicesView({
  provider,
  demo,
}: {
  provider: ProviderId;
  demo: boolean;
}) {
  const [days, setDays] = useState("30");
  const [named, setNamed] = useState(true);
  const [data, setData] = useState<SellerReport>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    setData(undefined);
    setError("");
    if (demo) return;
    api<SellerReport>(
      `/company-insights/${provider}/choices?days=${days}&named=${named ? 1 : 0}`,
    )
      .then((value) => !stale && setData(value))
      .catch((e) => !stale && setError((e as Error).message));
    return () => {
      stale = true;
    };
  }, [provider, days, named, demo]);
  if (demo)
    return (
      <Panel title="Agent choices from real tool use">
        <div className="lab-empty">
          <h3>Connect this view to your workspace</h3>
          <p>
            Choose Local lab above to see where agents chose this tool, where
            they chose another, and the reasons they gave.
          </p>
        </div>
      </Panel>
    );
  const f = data?.funnel;
  const steps = f
    ? [
        ["Eligible", f.eligible, "tasks this tool could have served", null],
        ["Chosen by the agent", f.chosen, "of eligible", f.chosenShare],
        ["Call succeeded", f.succeeded, "of chosen", f.succeededShare],
        ["Cited in the answer", f.cited, "of succeeded", f.citedShare],
      ]
    : [];
  return (
    <div className="provider-activity seller-choices">
      <div className="lab-result-heading">
        <div>
          <h2>Agent choices</h2>
          <p>Where agents chose this tool, where they chose another, and why</p>
        </div>
        <div className="activity-controls">
          <div className="choices-switch">
            <Label htmlFor="choices-named">Name other companies</Label>
            <Switch
              id="choices-named"
              checked={named}
              onCheckedChange={setNamed}
            />
          </div>
          <div>
            <Label htmlFor="choices-window">Time window</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger id="choices-window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[7, 30, 90].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    Last {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <InlineError message={error} />
      {!data && !error && <p role="status">Loading agent choices…</p>}
      {data && f && (
        <>
          {data.simulated && (
            <p className="choices-simulated" role="note">
              {data.simulated.note}
            </p>
          )}
          <Panel
            title="From eligible to cited"
            description={`A task is one recorded session. Shares need at least ${data.minSample} tasks.`}
          >
            <ol className="choices-funnel">
              {steps.map(([label, count, of, share]) => (
                <li key={String(label)}>
                  <div>
                    <span>{label}</span>
                    <small>
                      {share === null &&
                      of !== "of eligible" &&
                      label === "Eligible"
                        ? of
                        : `${percent(share as number | null)} ${of}`}
                    </small>
                  </div>
                  <span className="choices-track">
                    <span
                      style={{
                        width: `${f.eligible ? (Number(count) / f.eligible) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <strong>{count}</strong>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel
            title="Who was chosen, by kind of task"
            description="Only tasks where this tool was eligible. Neither means the agent answered without calling a tool of this kind. Task type is reported by the agent."
          >
            {data.byTaskType.length ? (
              <div className="lab-table-wrap">
                <table className="lab-table choices-table">
                  <thead>
                    <tr>
                      <th>Task type</th>
                      <th>Eligible</th>
                      <th>Chosen</th>
                      <th>{data.providerName}</th>
                      <th>Others</th>
                      <th>Neither</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTaskType.map((t) => {
                      const others = t.rivals.reduce((n, r) => n + r.count, 0);
                      return (
                        <tr key={t.taskType}>
                          <td>{t.label}</td>
                          <td>{t.eligible}</td>
                          <td>
                            <span
                              className="choices-stack"
                              role="img"
                              aria-label={`${data.providerName} ${t.you}, ${t.rivals.map((r) => `${r.label} ${r.count}`).join(", ") || "others 0"}, neither ${t.none}`}
                            >
                              <span
                                className="you"
                                style={{
                                  width: `${(t.you / t.eligible) * 100}%`,
                                }}
                              />
                              <span
                                className="rival"
                                style={{
                                  width: `${(others / t.eligible) * 100}%`,
                                }}
                              />
                            </span>
                          </td>
                          <td>{t.you}</td>
                          <td
                            title={t.rivals
                              .map((r) => `${r.label} ${r.count}`)
                              .join(", ")}
                          >
                            {others}
                          </td>
                          <td>{t.none}</td>
                          <td>{percent(t.share)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="choices-empty">No eligible tasks in this window.</p>
            )}
            {data.lostTo.length > 0 && (
              <p className="choices-note">
                Chosen instead:{" "}
                {data.lostTo.map((r) => `${r.label} in ${r.count}`).join(", ")}.
              </p>
            )}
          </Panel>
          <div className="choices-grid">
            <Panel
              title={`Why agents chose ${data.providerName}`}
              description="The theme each agent gave with its first call"
            >
              <Bars rows={data.reasonsFor} empty="No choices recorded yet." />
            </Panel>
            <Panel
              title="Why agents chose another tool"
              description="Same tasks this tool was eligible for"
            >
              <Bars
                rows={data.reasonsAgainst}
                empty="No losses recorded yet."
              />
            </Panel>
            <Panel
              title="Demand this tool could not serve"
              description="Requests of this kind where it was ruled out before the agent chose"
            >
              <Bars rows={data.missed} empty="Nothing was ruled out." />
            </Panel>
            <Panel
              title="When a call went wrong"
              description={`${data.calls.total} calls · ${data.calls.succeeded} succeeded · ${data.calls.emptyResults} returned nothing`}
            >
              <Bars
                rows={[
                  ...data.calls.failures,
                  ...data.calls.afterFailure.map((r) => ({
                    ...r,
                    label: `Then: ${r.label[0].toLowerCase()}${r.label.slice(1)}`,
                  })),
                ]}
                empty="No failed calls."
              />
            </Panel>
            <Panel title="Price as agents see it">
              <dl className="choices-facts">
                <div>
                  <dt>Average estimate shown</dt>
                  <dd>
                    {data.cost.averageEstimateMicros === null
                      ? "—"
                      : money(data.cost.averageEstimateMicros)}
                  </dd>
                </div>
                <div>
                  <dt>Average cost reported back</dt>
                  <dd>
                    {data.cost.averageReportedUsd === null
                      ? "Not reported"
                      : `${money(data.cost.averageReportedUsd * 1e6)} over ${data.cost.usdCalls} calls`}
                  </dd>
                </div>
                <div>
                  <dt>Tasks ruled out on budget</dt>
                  <dd>{data.cost.ruledOutOnBudget}</dd>
                </div>
                <div>
                  <dt>Tasks lost with lower cost as the reason</dt>
                  <dd>{data.cost.lostOnCost}</dd>
                </div>
                <div>
                  <dt>Calls octolab routed here, not counted as choices</dt>
                  <dd>{data.calls.routedByOctolab}</dd>
                </div>
              </dl>
            </Panel>
            <Panel
              title="Used alongside, and by which agents"
              description="Tasks that chose this tool. Agent names are self-reported."
            >
              <Bars
                rows={[
                  ...data.coUsage.map((r) => ({
                    ...r,
                    label: `With ${r.label}`,
                  })),
                  ...data.hosts,
                ]}
                empty="No tasks chose this tool yet."
              />
            </Panel>
          </div>
          <ul className="choices-notes">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
