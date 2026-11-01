import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ObservationApp } from "./ObservationApp";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./observation.css";
const Legacy = lazy(() => import("./Legacy"));
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p>Loading workspace…</p>}>
      {location.pathname.startsWith("/research") ? (
        <Legacy />
      ) : (
        <ObservationApp />
      )}
    </Suspense>
  </React.StrictMode>,
);
