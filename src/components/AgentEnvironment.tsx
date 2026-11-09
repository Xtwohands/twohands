import { CopyButton } from "../observation-ui";

export function AgentEnvironment() {
  const settings = `APILAYER_URL=${new URL("/api", location.origin).href}\nAPILAYER_API_KEY=<your scoped key>`;
  return (
    <div className="command-box ws-agent-environment">
      <code>{settings}</code>
      <CopyButton text={settings} />
    </div>
  );
}
