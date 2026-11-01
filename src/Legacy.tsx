import { App } from "./App";
import "./styles.css";
import "./legacy-theme.css";
export default function Legacy() {
  return (
    <div className="legacy-root">
      <a className="return-observation" href="/#sessions">
        ← Observation dashboard
      </a>
      <div className="legacy-workflow-note">
        Local research workflow · Provider choices here come from APILayer’s
        deterministic router. External agent decisions appear in the observation
        dashboard.
      </div>
      <App />
    </div>
  );
}
