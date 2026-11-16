import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TerminalSquare } from "@untitledui/icons";
import claudeMark from "./assets/claude-mark.svg";
import codexMark from "./assets/codex-mark.png";
import { useAccount } from "./AccountGate";
import { CopyButton } from "./observation-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import "./connect-agent.css";

const ConnectAgentContext = createContext<
  (returnFocus?: HTMLElement | null) => void
>(() => {});
export const useConnectAgent = () => useContext(ConnectAgentContext);

export function ConnectAgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  return (
    <ConnectAgentContext.Provider
      value={(returnFocus) => {
        trigger.current =
          returnFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null);
        setOpen(true);
      }}
    >
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="connect-agent-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else document.getElementById("main-content")?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Connect agent</DialogTitle>
            <DialogDescription>
              Use Two Hands in the agent you already work with.
            </DialogDescription>
          </DialogHeader>
          <AgentConnectionInstructions onNavigate={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </ConnectAgentContext.Provider>
  );
}

/** The hosted Streamable HTTP MCP endpoint served by this origin. */
export function mcpEndpoint() {
  return new URL("/mcp", location.origin).href;
}
const keyPlaceholder = "<your API key>";
function clientSetup(client: string, endpoint: string) {
  if (client === "claude")
    return {
      title: "Add Two Hands to Claude Code",
      note: "Run this in a terminal. Replace the placeholder with your API key.",
      text: [
        `claude mcp add --transport http twohands ${endpoint} \\`,
        `  --header "Authorization: Bearer ${keyPlaceholder}"`,
      ].join("\n"),
    };
  if (client === "codex")
    return {
      title: "Add Two Hands to Codex",
      note: "Add this to ~/.codex/config.toml, then set TWOHANDS_API_KEY to your API key in the environment Codex starts from.",
      text: [
        "[mcp_servers.twohands]",
        `url = "${endpoint}"`,
        'bearer_token_env_var = "TWOHANDS_API_KEY"',
        "tool_timeout_sec = 150",
      ].join("\n"),
    };
  return {
    title: "Add the server to your MCP client",
    note: "Use the Streamable HTTP transport and send your API key as a bearer token.",
    text: [
      `URL: ${endpoint}`,
      `Header: Authorization: Bearer ${keyPlaceholder}`,
    ].join("\n"),
  };
}

export function AgentConnectionInstructions({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const account = useAccount();
  const [client, setClient] = useState("codex");
  const canManageKeys = !account.enabled || !!account.profile;
  const setup = clientSetup(client, mcpEndpoint());
  return (
    <div className="agent-connection-instructions">
      <div className="ws-client-picker" role="group" aria-label="Agent client">
        {[
          { id: "codex", label: "Codex", logo: codexMark },
          { id: "claude", label: "Claude", logo: claudeMark },
          { id: "other", label: "Other MCP client", logo: undefined },
        ].map(({ id, label, logo }) => (
          <button
            key={id}
            aria-pressed={client === id}
            onClick={() => setClient(id)}
          >
            {logo ? (
              <img
                className="agent-client-logo"
                src={logo}
                width={18}
                height={18}
                alt=""
              />
            ) : (
              <TerminalSquare size={17} aria-hidden="true" />
            )}
            {label}
          </button>
        ))}
      </div>
      <ol className="ws-setup-steps">
        <li>
          <span>1</span>
          <div>
            <strong>Create an API key</strong>
            <p>
              {canManageKeys ? (
                <>
                  Use a separate scoped key for each agent.{" "}
                  <a
                    href="#dashboard/keys"
                    className="ws-text-link"
                    onClick={onNavigate}
                  >
                    Manage API keys
                  </a>
                </>
              ) : (
                "Ask your account owner for a scoped API key."
              )}
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>{setup.title}</strong>
            <p>{setup.note}</p>
            <div className="command-box ws-agent-environment">
              <code>{setup.text}</code>
              <CopyButton text={setup.text} />
            </div>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Restart your client and ask your agent</strong>
            <p>
              “Use Two Hands to find evidence for my next task.” Your agent
              records intent and chooses tools under the backend policy.
            </p>
          </div>
        </li>
      </ol>
    </div>
  );
}
