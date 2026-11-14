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
import { AgentEnvironment } from "./components/AgentEnvironment";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import "./user-dashboard.css";
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

export function AgentConnectionInstructions({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const account = useAccount();
  const [client, setClient] = useState("codex");
  const canManageKeys = !account.enabled || !!account.profile;
  const command =
    client === "other"
      ? "npm run mcp:install -- project"
      : `npm run mcp:install -- ${client}`;
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
      <p className="ws-panel-note">
        {canManageKeys ? (
          <>
            Use a separate scoped credential for each agent.{" "}
            <a
              href="#dashboard/keys"
              className="ws-text-link"
              onClick={onNavigate}
            >
              Manage API keys
            </a>{" "}
            before starting the bridge.
          </>
        ) : (
          "Ask your account owner for a scoped API key before starting the bridge."
        )}
      </p>
      <ol className="ws-setup-steps">
        <li>
          <span>1</span>
          <div>
            <strong>Build the local MCP bridge</strong>
            <p>
              Run this in the Two Hands project folder. If you run the server
              locally, keep it running in a separate terminal.
            </p>
            <div className="command-box">
              <code>npm run build</code>
              <CopyButton text="npm run build" />
            </div>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Add your connection settings</strong>
            <p>
              Save these in the bridge project’s private .env file. Replace the
              placeholder with your API key. The address points to this Two
              Hands server, including its port.
            </p>
            <AgentEnvironment />
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>
              {client === "other"
                ? "Create the MCP configuration"
                : `Install the ${client === "codex" ? "Codex" : "Claude"} connection`}
            </strong>
            <p>
              {client === "other"
                ? "Creates .mcp.json in the project. Use its stdio server entry in your MCP client."
                : "The installer preserves existing settings and backs up changed files."}
            </p>
            <div className="command-box">
              <code>{command}</code>
              <CopyButton text={command} />
            </div>
          </div>
        </li>
        <li>
          <span>4</span>
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
