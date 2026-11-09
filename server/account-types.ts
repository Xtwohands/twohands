export interface AccountWorkspace {
  id: string;
  name: string;
  role: "owner" | "member" | "platform_admin";
}
export interface AccountProfile {
  user: { id: string; email: string };
  workspaces: AccountWorkspace[];
  isAdmin: boolean;
}
export type AuthPublicConfig =
  { enabled: false } | { enabled: true; url: string; publishableKey: string };
