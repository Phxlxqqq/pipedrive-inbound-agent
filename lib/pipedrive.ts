// lib/pipedrive.ts
import { env } from "./env";

export type PipedriveUpdateFields = Record<string, any>;

export type PipedrivePerson = {
  id: number;
  name?: string;
  first_name?: string;
  email?: { value: string }[];
  primary_email?: string;
};

/**
 * Deal aktualisieren
 */
export async function updateDeal(
  dealId: number,
  fields: PipedriveUpdateFields
): Promise<void> {
  const url = `${env.pipedrive.baseUrl}/deals/${dealId}?api_token=${env.pipedrive.token}`;

  console.log("[PIPEDRIVE] Updating deal", { url, dealId, fields });

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

  console.log("[PIPEDRIVE] Update success", { dealId, status: res.status });
}

/**
 * Person aus Pipedrive laden, um z.B. Email & Vorname zu bekommen
 */
export async function getPerson(personId: number): Promise<PipedrivePerson> {
  const url = `${env.pipedrive.baseUrl}/persons/${personId}?api_token=${env.pipedrive.token}`;

  console.log("[PIPEDRIVE] Fetching person", { url, personId });

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("[PIPEDRIVE] Get person failed", {
      status: res.status,
      body: text,
    });
    throw new Error(`Pipedrive getPerson failed with status ${res.status}`);
  }

  const json = JSON.parse(text);
  return json.data as PipedrivePerson;
}
