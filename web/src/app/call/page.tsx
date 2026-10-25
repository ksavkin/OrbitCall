import { Suspense } from "react";
import { CallGate } from "./CallGate";

// Test page of the call module: /call?room=<roomId>&token=<devToken>. Tokens come from `npx convex run call/demo:seed`
// (with CALL_DEV_IDENTITY=on on a development deployment) until sign-in exists. The coordination room screen renders
// the call the same way, with roomId from the route and no token once Auth0 is wired.
export default function CallPage({ searchParams }: PageProps<"/call">) {
  return (
    <Suspense fallback={null}>
      <Call searchParams={searchParams} />
    </Suspense>
  );
}

async function Call({ searchParams }: { searchParams: PageProps<"/call">["searchParams"] }) {
  const params = await searchParams;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-4">
      <CallGate roomId={str(params.room)} devToken={str(params.token)} />
    </div>
  );
}
