// api/pipedrive-webhook.ts

import { env } from "../lib/env";
import { buildCompanyIntro } from "../lib/companyEnricher";
import type { CompanyIntro } from "../lib/companyEnricher";
import { generateFollowupMails } from "../lib/mailGenerator";
import { updateDeal, getPerson } from "../lib/pipedrive";

export const config = {
  runtime: "edge",
};

// Hilfsfunktion: baut ein sauberes, professionelles Enrichment-Summary
function buildEnrichmentSummary(ci: CompanyIntro): string {
  const parts: string[] = [];

  // 1. Firmenname
  parts.push(ci.companyName);

  // 2. Branche (falls vorhanden und nicht nur "unbekannt")
  if (ci.industry && ci.industry.toLowerCase() !== "unbekannt") {
    parts.push(`Branche: ${ci.industry}`);
  }

  // 3. One-Liner (nur, wenn kein generischer Fallback)
  if (ci.oneLiner && ci.oneLiner !== "ein Unternehmen in deinem Bereich") {
    parts.push(ci.oneLiner);
  }

  // 4. Themen (falls vorhanden)
  if (ci.topics && ci.topics.length > 0) {
    parts.push(`Themen: ${ci.topics.join(", ")}`);
  }

  // 5. Fallback, wenn wir quasi nichts wissen
  if (parts.length === 1) {
    parts.push("Profil aktuell nur teilweise verfügbar — weitere Infos folgen.");
  }

  return parts.join(" | ");
}

export default async function handler(req: Request): Promise<Response> {
  console.log("[WEBHOOK] Hit", req.method, req.url);

  if (req.method !== "POST") {
    console.log("[WEBHOOK] Method not allowed:", req.method);
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Secret aus Query
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");

    if (secret !== env.webhookSecret) {
      console.warn("[WEBHOOK] Wrong secret", { got: secret });
      return new Response("Forbidden", { status: 403 });
    }

    const payload: any = await req.json();
    console.log("[WEBHOOK] Incoming payload:", JSON.stringify(payload));

    const current: any =
      payload.current || payload.data || payload.deal || payload.meta?.current;

    if (!current) {
      console.error("[WEBHOOK] No deal in payload");
      return new Response("No deal", { status: 400 });
    }

    const dealId: number = current.id;
    console.log("[WEBHOOK] Current deal", {
      id: dealId,
      pipeline_id: current.pipeline_id,
      stage_id: current.stage_id,
      product_name: current.product_name,
      title: current.title,
    });

    const webformTitle: string =
      current.title || current.subject || "Anfrage über Webformular";

    // Optional: Pipeline-Filter
    if (env.pipelineId && String(current.pipeline_id) !== env.pipelineId) {
      console.log("[WEBHOOK] Ignored (pipeline mismatch)", {
        dealPipeline: current.pipeline_id,
        expected: env.pipelineId,
      });
      return new Response("Ignored (pipeline)", { status: 200 });
    }

    // Optional: Stage-Filter
    if (env.stageId && String(current.stage_id) !== env.stageId) {
      console.log("[WEBHOOK] Ignored (stage mismatch)", {
        dealStage: current.stage_id,
        expected: env.stageId,
      });
      return new Response("Ignored (stage)", { status: 200 });
    }

    // Optional: Produkt-Filter – falls du das über Titel/Produkt triggern willst
    if (env.productTrigger) {
      const productName = String(current.product_name || current.title || "");
      if (!productName.includes(env.productTrigger)) {
        console.log("[WEBHOOK] Ignored (product mismatch)", {
          productName,
          trigger: env.productTrigger,
        });
        return new Response("Ignored (product)", { status: 200 });
      }
    }

    // ---------- PERSON & EMAIL ROBUST ERMITTELN ----------

    const personRef: any = current.person_id || current.person || null;

    let email: string | undefined;
    let leadFirstName: string | undefined;
    let personName: string | undefined;
    let orgNameFromPerson: string | null = null;

    // 1) Falls im Webhook schon ein Person-Objekt steckt
    if (personRef && typeof personRef === "object") {
      personName = personRef.name;
      leadFirstName =
        personRef.first_name ||
        (personRef.name && String(personRef.name).split(" ")[0]);

      email =
        personRef.email?.[0]?.value ||
        personRef.primary_email ||
        current.email ||
        current.person_email;

      // Org-Name evtl. direkt am Person-Objekt
      orgNameFromPerson =
        personRef.org_name ||
        (personRef.org_id && typeof personRef.org_id === "object"
          ? personRef.org_id.name
          : null) ||
        null;
    }

    // 2) Personen-ID extrahieren
    let personId: number | undefined;

    if (typeof personRef === "number") {
      personId = personRef;
    } else if (
      personRef &&
      typeof personRef === "object" &&
      typeof personRef.value === "number"
    ) {
      // übliches Pipedrive-Format: { value: 123, name: "Anna Beispiel" }
      personId = personRef.value;
    }

    // 3) Wenn wir noch keine E-Mail haben, Person via API nachladen
    if (!email && personId) {
      try {
        const person: any = await getPerson(personId);
        console.log("[WEBHOOK] Loaded person from API", person);

        personName = person.name || personName;
        leadFirstName =
          person.first_name ||
          leadFirstName ||
          (person.name && person.name.split(" ")[0]);

        if (person.email && person.email.length > 0) {
          email = person.email[0].value;
        } else if (person.primary_email) {
          email = person.primary_email;
        }

        // Org-Name auch hier aus der Person ziehen
        orgNameFromPerson =
          person.org_name ||
          (person.org_id && typeof person.org_id === "object"
            ? person.org_id.name
            : null) ||
          orgNameFromPerson;
      } catch (e) {
        console.error("[WEBHOOK] Failed to load person", e);
      }
    }

    // 4) Wenn wir IMMER noch keine E-Mail haben → abbrechen
    if (!email) {
      console.error("[WEBHOOK] No email for deal", { dealId });
      return new Response("No email", { status: 200 });
    }

    // leadFirstName Fallback
    if (!leadFirstName && personName) {
      leadFirstName = personName.split(" ")[0];
    }

    // ---------- ORG-NAME ERMITTELN ----------

    // 1. aus Deal
    let orgNameRaw: string | null =
      current.org_name ||
      (current.org_id && typeof current.org_id === "object"
        ? current.org_id.name
        : null) ||
      null;

    // 2. Fallback: aus Person (wenn Deal nichts hatte)
    if (!orgNameRaw && orgNameFromPerson) {
      orgNameRaw = orgNameFromPerson;
    }

    console.log("[WEBHOOK] Lead data", {
      email,
      leadFirstName,
      orgNameRaw,
      webformTitle,
    });

    // 1) Company-Enrichment über Brave
    const companyIntro = await buildCompanyIntro({
      email,
      orgNameRaw,
    });

    console.log("[WEBHOOK] CompanyIntro", companyIntro);

    // 2) Follow-up-Mails generieren
    const mails = await generateFollowupMails({
      webformTitle,
      leadEmail: email,
      leadFirstName,
      companyIntro,
    });

    console.log("[WEBHOOK] Generated mails", {
      firstLen: mails.first?.length,
      secondLen: mails.second?.length,
      thirdLen: mails.third?.length,
    });

    // 3) Enrichment-Summary bauen
    const enrichmentSummary = buildEnrichmentSummary(companyIntro);
    console.log("[WEBHOOK] Enrichment summary", enrichmentSummary);

    // 4) Deal-Felder schreiben
    const updatePayload: Record<string, any> = {
      [env.fields.enrichmentSummary]: enrichmentSummary,
      [env.fields.companyIndustry]: companyIntro.industry ?? "",
      [env.fields.emailIntro1]: mails.first,
      [env.fields.emailIntro2]: mails.second,
      [env.fields.emailIntro3]: mails.third,
    };

    console.log("[WEBHOOK] Update payload", updatePayload);

    await updateDeal(dealId, updatePayload);

    console.log("[WEBHOOK] Done for deal", dealId);
    return new Response("ok", { status: 200 });
  } catch (err: any) {
    console.error("[WEBHOOK] Unhandled error", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
