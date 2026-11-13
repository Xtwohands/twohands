import { useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import {
  ChevronUp,
  HelpCircle,
  LogOut01,
  Settings01,
  User01,
} from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";

export function AccountMenu({
  label,
  detail,
  onSignOut,
  children,
  settingsHref = "#settings",
  onSettings,
}: {
  label: string;
  detail?: string;
  onSignOut?: () => void;
  children?: ReactNode;
  settingsHref?: string;
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          ref={trigger}
          className="account-menu-trigger"
          aria-label={`Account menu: ${label}${detail ? ` ${detail}` : ""}`}
        >
          <span className="account-menu-avatar" aria-hidden="true">
            <User01 />
          </span>
          <span className="account-menu-identity">
            <strong title={label}>{label}</strong>{" "}
            {detail && <small>{detail}</small>}
          </span>
          <ChevronUp className="account-menu-chevron" aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="account-menu-popover"
            side="top"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            aria-label="Account options"
            onCloseAutoFocus={(event) => {
              if (helpOpen) event.preventDefault();
            }}
          >
            <div className="account-menu-heading">
              <strong>{label}</strong>
              {detail && <small>{detail}</small>}
            </div>
            {children && (
              <div className="account-menu-controls">{children}</div>
            )}
            <nav aria-label="Account navigation">
              <a
                href={settingsHref}
                onClick={(event) => {
                  if (onSettings) {
                    event.preventDefault();
                    onSettings();
                  }
                  setOpen(false);
                }}
              >
                <Settings01 />
                Settings
              </a>
              <button
                onClick={() => {
                  setOpen(false);
                  setHelpOpen(true);
                }}
              >
                <HelpCircle />
                Help and documentation
              </button>
            </nav>
            {onSignOut && (
              <button
                className="account-menu-signout"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                <LogOut01 />
                Sign out
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent
          className="account-help-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Help and documentation</DialogTitle>
            <DialogDescription>
              Use Two Hands tools in the agent you already work with.
            </DialogDescription>
          </DialogHeader>
          <div className="account-help-topics">
            <a href="#dashboard/connections" onClick={() => setHelpOpen(false)}>
              <strong>Connect an agent</strong>
              <span>
                Follow the setup steps for Claude, Codex, or another MCP client.
                Create a scoped API key when prompted.
              </span>
            </a>
            <a href="#dashboard/tools" onClick={() => setHelpOpen(false)}>
              <strong>Explore the tool catalog</strong>
              <span>
                Compare capabilities, availability, and estimated costs. Your
                agent chooses which tools to use for your task.
              </span>
            </a>
            <a href="#dashboard/activity" onClick={() => setHelpOpen(false)}>
              <strong>Inspect tool activity</strong>
              <span>
                Review recorded requests, returned evidence, and execution
                status. Estimated costs and provider-reported usage are shown
                separately.
              </span>
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
