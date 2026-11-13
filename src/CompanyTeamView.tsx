import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Panel, InlineError, date } from "./observation-ui";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import type { CompanyMember } from "../server/company-team";
type AccessEvent = {
  id: string;
  actorId: string;
  action: "member_granted" | "member_revoked" | "report_accessed";
  at: string;
  data: Record<string, unknown>;
};
export function CompanyTeamView({ companyId }: { companyId: string }) {
  const [members, setMembers] = useState<CompanyMember[]>([]),
    [events, setEvents] = useState<AccessEvent[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [email, setEmail] = useState("");
  const requestKey = useRef(crypto.randomUUID()),
    generation = useRef(0);
  const load = async () => {
    const version = ++generation.current;
    const rows = await api<CompanyMember[]>(`/companies/${companyId}/members`);
    const audit = await api<AccessEvent[]>(
      `/companies/${companyId}/access-history`,
    );
    if (version === generation.current) {
      setMembers(rows);
      setEvents(audit);
    }
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    return () => {
      generation.current++;
    };
  }, [companyId]);
  const change = async (body: unknown, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/companies/${companyId}/members`, body);
      await load();
      setNotice(message);
      setEmail("");
      requestKey.current = crypto.randomUUID();
    } catch (e) {
      setMembers([]);
      setEvents([]);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <InlineError message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <Panel
        title="Company team"
        description="Analysts can read your company’s approved aggregate insights. Only owners can manage the team or change a registration."
      >
        <div className="portal-company-list">
          {members.map((member) => (
            <div className="portal-team-member" key={member.id}>
              <div>
                <strong>{member.email}</strong>
                <p>{member.role === "owner" ? "Company owner" : "Analyst"}</p>
              </div>
              {member.role === "analyst" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      {
                        action: "revoke",
                        userId: member.id,
                        requestKey: crypto.randomUUID(),
                      },
                      "Team access removed.",
                    )
                  }
                >
                  Remove access
                </Button>
              )}
            </div>
          ))}
        </div>
        <form
          className="portal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void change(
              { action: "grant", email, requestKey: requestKey.current },
              "Analyst access added.",
            );
          }}
        >
          <label>
            Analyst email
            <Input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
          </label>
          <p>
            The person needs an existing confirmed Two Hands account. Adding
            them grants access to this company only.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add analyst"}
          </Button>
        </form>
      </Panel>
      <Panel
        title="Access history"
        description="Recent team changes and aggregate report access."
      >
        {events.length ? (
          <div className="portal-audit">
            {events.map((event) => (
              <div key={event.id}>
                <strong>
                  {
                    {
                      member_granted: "Analyst access added",
                      member_revoked: "Analyst access removed",
                      report_accessed: "Aggregate report opened",
                    }[event.action]
                  }
                </strong>
                <p>
                  {date(event.at)} ·{" "}
                  {members.find((m) => m.id === event.actorId)?.email ??
                    "Former team member or administrator"}
                </p>
                {event.action === "report_accessed" && (
                  <p>
                    {{
                      available: "Report available",
                      awaiting_release: "Awaiting data access review",
                      insufficient_data: "No eligible usage recorded",
                    }[String(event.data.status)] ?? "Access recorded"}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p>No access events yet.</p>
        )}
      </Panel>
    </>
  );
}
