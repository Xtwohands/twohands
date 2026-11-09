import type { ProviderId } from "./types.js";
export interface ToolCompany {
  id: string;
  name: string;
  website: string;
  toolName: string;
  description: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  providerId: ProviderId | null;
  insightsEnabled: boolean;
  feedback: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CompanyInsights {
  providerId: ProviderId;
  minimumCohort: number;
  status: "available" | "awaiting_release" | "insufficient_data";
  metrics: null | {
    offeredSessions: number;
    selectedSessions: number;
    calls: number;
    successfulCalls: number;
  };
}
export interface CompanyReviewItem extends ToolCompany {
  ownerEmail: string;
}
