import {
  Building07,
  Grid01,
  CreditCard01,
  TerminalSquare,
  Key01,
  BarChartSquare02,
  Link01,
  ShieldTick,
  Settings01,
} from "@untitledui/icons";
import { useAccount } from "./AccountGate";
const links = [
  { page: "admin", label: "Company reviews", icon: Building07 },
  { page: "sessions", label: "Workspace operations", icon: Grid01 },
  { page: "disputes", label: "Payment disputes", icon: CreditCard01 },
  { page: "lab", label: "Provider lab", icon: TerminalSquare },
  { page: "tool-access", label: "Tool access", icon: Key01 },
  { page: "tool-settings", label: "Tool settings", icon: Settings01 },
  { page: "models", label: "Model evaluations", icon: BarChartSquare02 },
  { page: "tools", label: "Tool activity", icon: Link01 },
  { page: "cases", label: "Review cases", icon: ShieldTick },
];
/** Same destinations in every admin shell, including routes without a workspace. */
export function AdminNavigation({
  page,
  onNavigate,
}: {
  page: string;
  onNavigate?: () => void;
}) {
  const account = useAccount();
  return (
    <>
      {account.profile?.adminMfaVerified === false && (
        <a href="#settings" className="admin-mfa-notice">
          Verify two-factor access in Settings
        </a>
      )}
      {links.map((link) => (
        <a
          key={link.page}
          href={`#${link.page}`}
          className={page === link.page ? "selected" : ""}
          aria-current={page === link.page ? "page" : undefined}
          onClick={onNavigate}
        >
          <link.icon />
          {link.label}
        </a>
      ))}
    </>
  );
}
