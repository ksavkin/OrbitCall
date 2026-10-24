import type { ReactNode } from "react";

/** Tinted status pill: text, background and rim all from one color. */
export function Chip({
  color,
  children,
  dot,
  icon,
  className = "",
  size = "md",
}: {
  color: string;
  children: ReactNode;
  dot?: boolean;
  icon?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ${size === "sm" ? "h-[18px] px-1.5 text-[10px]" : "h-[22px] px-2 text-[10.5px]"} ${className}`}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      {dot && <span className="pulse-dot" style={{ width: 5, height: 5 }} />}
      {icon}
      {children}
    </span>
  );
}
