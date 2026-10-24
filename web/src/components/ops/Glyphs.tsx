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

// Real marks, inlined so size and color stay in CSS.
// Claude: Simple Icons "claude" (CC0), brand color #D97757. Trademark of Anthropic.
// Grok: Wikimedia Commons "Grok-feb-2025-logo.svg" (public domain), mark only. Trademark of X.AI Corp.

const CLAUDE_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

const GROK_PATHS = [
  "M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436",
  "M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341",
];

export function ClaudeGlyph({ size = 16, color = "#D97757" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-label="Claude" role="img">
      <path d={CLAUDE_PATH} />
    </svg>
  );
}

export function GrokGlyph({ size = 16, color = "#f2f3f5" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 33" fill={color} aria-label="Grok" role="img">
      {GROK_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
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
  if (vendor === "xai") return <GrokGlyph size={size} />;
  return <ClaudeGlyph size={size} />;
}

export function NodeGlyph({ id, size = 16 }: { id: NodeId; size?: number }) {
  if (id in AGENTS) return <ModelGlyph model={AGENTS[id as AgentId].model} size={size} />;
  if (id === "humanA" || id === "humanB") return <User size={size - 2} strokeWidth={1.8} />;
  const Icon = TOOL_ICON[id as ToolId];
  return <Icon size={size - 2} strokeWidth={1.8} />;
}
