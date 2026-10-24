import { connection } from "next/server";
import { getCatalogJson } from "@/lib/catalog/build";

export async function GET() {
  await connection();
  return new Response(await getCatalogJson(), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=600",
    },
  });
}
