import type { Metadata } from "next";
import { ObserverScreen } from "@/components/observer/ObserverScreen";

export const metadata: Metadata = {
  title: "OrbitCall · Public view",
  description: "Read-only view of the current case for a large display.",
};

// The observer's large display: read only, no controls, no policy or agent traces.
export default function ObserverPage() {
  return <ObserverScreen />;
}
