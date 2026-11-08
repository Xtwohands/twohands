import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, SearchLg } from "@untitledui/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { api, money } from "./api";
import "./landing.css";

type CatalogItem = {
  tool: string;
  provider: string;
  description: string;
  available: boolean;
  estimatedMicros: number;
};

function providerLabel(provider: string) {
  if (provider === "exa") return "Exa";
  if (provider === "tavily") return "Tavily";
  return "Firecrawl";
}

export function LandingView() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    api<CatalogItem[]>("/observations/catalog")
      .then((data) => {
        if (active) {
          setCatalog(data);
          setLoading(false);
          setLoadError("");
        }
      })
      .catch((e) => {
        if (active) {
          setLoading(false);
          setLoadError(e instanceof Error ? e.message : "Catalog unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((item) =>
      `${item.tool} ${item.provider} ${item.description}`
        .toLowerCase()
        .includes(q),
    );
  }, [catalog, query]);

  const availableCount = catalog.filter((c) => c.available).length;

  return (
    <div className="landing dark">
      <a className="skip-link" href="#landing-catalog">
        Skip to tool catalog
      </a>
      <header className="landing-nav">
        <a href="#home" className="landing-brand">
          <img src="/octolab.svg" alt="" width={28} height={28} />
          <span>octolab</span>
        </a>
        <div className="landing-nav-actions">
          <Button variant="outline" size="sm" asChild>
            <a href="#settings">Connect agent</a>
          </Button>
          <Button size="sm" asChild>
            <a href="#sessions">
              Open workspace
              <ArrowUpRight />
            </a>
          </Button>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <h1>One connection for every tool your agent needs</h1>
          <p>
            Octolab routes search and extraction through a single local gateway
            for Claude, Codex, and other MCP hosts. Every call is recorded with
            estimates and outcomes.
          </p>
          <div className="landing-cta-row">
            <Button asChild>
              <a href="#settings">Connect with one command</a>
            </Button>
            <Button variant="outline" asChild>
              <a href="#landing-catalog">Browse the catalog</a>
            </Button>
          </div>
          <pre className="landing-command">
            <code>npm run mcp:install</code>
          </pre>
          <p className="landing-status">
            <span className="status-dot online" aria-hidden />
            {loading
              ? "Checking local tool availability…"
              : `${availableCount} of ${catalog.length} tools configured locally`}
          </p>
        </section>

        <section id="landing-catalog" className="landing-section" tabIndex={-1}>
          <h2>Tool catalog</h2>
          <div className="search-input">
            <SearchLg aria-hidden />
            <Input
              aria-label="Search tools"
              placeholder="Search tools…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {loading ? (
            <p className="loading-state" role="status">
              Loading catalog…
            </p>
          ) : loadError ? (
            <p className="loading-state" role="alert">
              Catalog unavailable: {loadError}
            </p>
          ) : filtered.length ? (
            <div className="landing-table-wrap">
              <table className="landing-table">
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col">Estimate</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.tool}>
                      <td>
                        <code>{item.tool}</code>
                        <span className="landing-table-desc">
                          {providerLabel(item.provider)} · {item.description}
                        </span>
                      </td>
                      <td>{money(item.estimatedMicros)}</td>
                      <td>
                        <span
                          className={`landing-pill ${item.available ? "on" : ""}`}
                        >
                          {item.available ? "Configured" : "Missing key"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="loading-state" role="status">
              No tools match this search.
            </p>
          )}
        </section>

        <section className="landing-section">
          <h2>How it works</h2>
          <ol className="landing-steps">
            <li>
              <strong>Describe the need.</strong> The agent records intent and
              discovers options.
            </li>
            <li>
              <strong>Pick a provider.</strong> The agent names one explicitly
              and explains why.
            </li>
            <li>
              <strong>Run and review.</strong> Usage and outputs are recorded
              for review.
            </li>
          </ol>
        </section>

        <section className="landing-cta">
          <h2>Start routing in minutes</h2>
          <p>Keep the server running, install the MCP entry, and ask your agent to use it.</p>
          <div className="landing-cta-row">
            <Button asChild>
              <a href="#settings">Connect agent</a>
            </Button>
            <Button variant="outline" asChild>
              <a href="#sessions">Open workspace</a>
            </Button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Intent to tool use to outcome</span>
      </footer>
    </div>
  );
}
