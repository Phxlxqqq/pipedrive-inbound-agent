// lib/pipedrive.ts
import { env } from "./env";

export async function updateDeal(
  dealId: number,
  fields: Record<string, any>
): Promise<void> {
  const url = `${env.pipedrive.baseUrl}/deals/${dealId}?api_token=${env.pipedrive.token}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });

  if (!res.ok) {
    console.error("Pipedrive update failed", res.status, await res.text());
    throw new Error("Pipedrive update failed");
  }
}
