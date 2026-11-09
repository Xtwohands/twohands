import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AccountGate } from "./AccountGate";
import { ObservationApp } from "./ObservationApp";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./observation.css";
const Legacy = lazy(() => import("./Legacy"));
const insecureRemote =
  location.protocol === "http:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const secureUrl = new URL(location.href);
secureUrl.protocol = "https:";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {insecureRemote ? (
      <main className="account-page">
        <a className="account-brand" href="#home">
          <img src="/octolab.svg" width="34" height="34" alt="" />
          octolab
        </a>
        <section className="account-card">
          <h1>Open octolab securely</h1>
          <p role="alert">
            This page uses a remote HTTP address. Open octolab over HTTPS to
            sign in or connect an agent. HTTP is supported on localhost.
          </p>
          <a className="ws-text-link" href={secureUrl.href}>
            Open HTTPS address
          </a>
        </section>
      </main>
    ) : (
      <AccountGate>
        <Suspense fallback={<p>Loading workspace…</p>}>
          {location.pathname.startsWith("/research") ? (
            <Legacy />
          ) : (
            <ObservationApp />
          )}
        </Suspense>
      </AccountGate>
    )}
  </React.StrictMode>,
);
