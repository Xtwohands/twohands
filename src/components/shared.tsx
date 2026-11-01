import type React from "react";

export function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}

export function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className={`provider-mark ${provider}`}>
      {provider === "exa" ? "e" : provider === "tavily" ? "t" : "f"}
    </span>
  );
}
