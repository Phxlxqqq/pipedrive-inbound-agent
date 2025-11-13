// lib/pipedrive.ts
import { env } from "./env";

export type PipedriveUpdateFields = Record<string, any>;

/**
 * Aktualisiert einen Deal in Pipedrive.
 * Erwartet, dass env.pipedrive.baseUrl so aussieht:
 *   https://DEINUNTERNEHMEN.pipedrive.com/api/v1
 */
export async function updateDeal(
  dealId: number,
  fields: PipedriveUpdateFields
): Promise<void> {
  const url = `${env.pipedrive.baseUrl}/deals/${dealId}?api_token=${env.pipedrive.token}`;

  console.log("[PIPEDRIVE] Updating deal", {
    url,
    dealId,
    fields,
  });

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("[PIPEDRIVE] Update failed", {
      status: res.status,
      body: text,
    });
    throw new Error(`Pipedrive update failed with status ${res.status}`);
  }

  console.log("[PIPEDRIVE] Update success", {
    dealId,
    status: res.status,
    body: text,
  });
}
