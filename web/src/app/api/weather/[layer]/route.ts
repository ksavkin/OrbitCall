import { connection } from "next/server";
import { getClouds, getCurrents, getSpaceWeather, getStorms, getTornado, getWind } from "@/lib/weather/sources";

const JSON_LAYERS = {
  wind: getWind,
  currents: getCurrents,
  storms: getStorms,
  tornado: getTornado,
  space: getSpaceWeather,
} as const;

export async function GET(_req: Request, ctx: RouteContext<"/api/weather/[layer]">) {
  await connection();
  const { layer } = await ctx.params;
  try {
    if (layer === "clouds") {
      const c = await getClouds();
      return new Response(new Uint8Array(c.data.png), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=600",
          "X-Observed-At": c.data.observedAt,
          "X-Fetched-At": c.fetchedAt,
          "X-Source": c.source,
        },
      });
    }
    const fn = JSON_LAYERS[layer as keyof typeof JSON_LAYERS];
    if (!fn) return Response.json({ error: `unknown layer ${layer}` }, { status: 404 });
    const c = await fn();
    return Response.json(c, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
