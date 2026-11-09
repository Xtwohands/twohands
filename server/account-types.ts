export interface AccountWorkspace {
  id: string;
  name: string;
  role: "owner" | "member" | "platform_admin";
}
export interface AccountProfile {
  user: { id: string; email: string };
  workspaces: AccountWorkspace[];
  isAdmin: boolean;
  canPreview?: boolean;
  adminMfaVerified?: boolean;
  companyPreview?: import("./company-types.js").CompanyPreviewTarget;
  companies: import("./company-types.js").ToolCompany[];
}
export type AuthPublicConfig =
  { enabled: false } | { enabled: true; url: string; publishableKey: string };
