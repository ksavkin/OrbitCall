import {
  CalendarClock,
  Database,
  FileExclamationPoint,
  MessagesSquare,
  Orbit,
  Satellite,
  ScrollText,
  Table2,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AGENTS, MODELS } from "@/lib/ops/roster";
import type { AgentId, NodeId, ToolId } from "@/lib/ops/types";

/** Eight-ray spark for Claude-backed agents (drawn here, not a brand asset). */
export function SparkGlyph({ size = 16, color = "#d97757" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <line
          key={i}
          x1="12"
          y1="12"
          x2="12"
          y2={i % 2 ? 4.2 : 2.4}
          stroke={color}
          strokeWidth={i % 2 ? 2.1 : 2.5}
          strokeLinecap="round"
          transform={`rotate(${i * 45} 12 12)`}
        />
      ))}
    </svg>
  );
}

/** Slash mark for Grok-backed agents (drawn here, not a brand asset). */
export function SlashGlyph({ size = 16, color = "#f2f3f5" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 19 L17.5 4.5" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M5 8.5 L10.2 14.6" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeOpacity="0.55" />
      <path d="M14.6 13.4 L19 19" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeOpacity="0.55" />
    </svg>
  );
}

const TOOL_ICON: Record<ToolId, LucideIcon> = {
  sgp4: Orbit,
  celestrak: Satellite,
  socrates: Table2,
  spacetrack: FileExclamationPoint,
  keeptrack: Users,
  policy: ScrollText,
  convex: Database,
  room: MessagesSquare,
  schedule: CalendarClock,
};

export function ModelGlyph({ model, size = 16 }: { model?: string; size?: number }) {
  const vendor = model ? MODELS[model]?.vendor : undefined;
  if (vendor === "xai") return <SlashGlyph size={size} />;
  return <SparkGlyph size={size} />;
}

export function NodeGlyph({ id, size = 16 }: { id: NodeId; size?: number }) {
  if (id in AGENTS) return <ModelGlyph model={AGENTS[id as AgentId].model} size={size} />;
  if (id === "humanA" || id === "humanB") return <User size={size - 2} strokeWidth={1.8} />;
  const Icon = TOOL_ICON[id as ToolId];
  return <Icon size={size - 2} strokeWidth={1.8} />;
}
