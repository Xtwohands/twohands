export interface AccountProfile {
  user: { id: string; email: string };
  hasPersonalAccount: boolean;
  isAdmin: boolean;
  canPreview?: boolean;
  companyPreview?: import("./company-types.js").CompanyPreviewTarget;
  companies: import("./company-types.js").ToolCompany[];
}
export type AuthPublicConfig =
  { enabled: false } | { enabled: true; url: string; publishableKey: string };
