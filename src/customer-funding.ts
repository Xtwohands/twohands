import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { FundingSummary } from "../server/funding-types";
import { api } from "./api";

export function useCustomerFunding(
  enabled: boolean,
  scope: string,
  onCreditsPage: boolean,
) {
  const [state, setState] = useState<{
    scope: string;
    summary?: FundingSummary;
    error: string;
  }>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++generation.current;
    try {
      const summary = await api<FundingSummary>("/workspace/funding");
      if (id === generation.current) setState({ scope, summary, error: "" });
    } catch (error) {
      if (id === generation.current)
        setState({ scope, error: (error as Error).message });
    }
  }, [enabled, scope]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(
      () => void refresh(),
      onCreditsPage ? 10000 : 60000,
    );
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [enabled, onCreditsPage, refresh]);

  const current = enabled && state?.scope === scope ? state : undefined;
  return {
    summary: current?.summary,
    error: current?.error ?? "",
    loading: !current,
    refresh,
  };
}

export const CustomerFunding = createContext<
  ReturnType<typeof useCustomerFunding> & { focusPaymentMethods: boolean }
>({
  summary: undefined,
  error: "",
  loading: true,
  focusPaymentMethods: false,
  refresh: async () => {},
});
