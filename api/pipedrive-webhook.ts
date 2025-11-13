// api/pipedrive-webhook.ts

import { env } from "../lib/env";
import { buildCompanyIntro } from "../lib/companyEnricher";
import { generateFollowupMails } from "../lib/mailGenerator";
import { updateDeal } from "../lib/pipedrive";

export const config = {
  runtime: "edge",
};

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

    const current =
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

    // Pipeline-Filter
    if (env.pipelineId && String(current.pipeline_id) !== env.pipelineId) {
      console.log("[WEBHOOK] Ignored (pipeline mismatch)", {
        dealPipeline: current.pipeline_id,
        expected: env.pipelineId,
      });
      return new Response("Ignored (pipeline)", { status: 200 });
    }

    // Stage-Filter
    if (env.stageId && String(current.stage_id) !== env.stageId) {
      console.log("[WEBHOOK] Ignored (stage mismatch)", {
        dealStage: current.stage_id,
        expected: env.stageId,
      });
      return new Response("Ignored (stage)", { status: 200 });
    }

    const webformTitle: string =
      current.title || current.subject || "Anfrage über Webformular";

    // // Produkt-Filter (optional)
    // if (env.productTrigger) {
    //   const productName = current.product_name
    //     ? String(current.product_name)
    //     : "";
    //   if (!productName.includes(env.productTrigger)) {
    //     console.log("[WEBHOOK] Ignored (product mismatch)", {
    //       productName,
    //       trigger: env.productTrigger,
    //     });
    //     return new Response("Ignored (product)", { status: 200 });
    //   }
    // }

    // Person & Email
    const person = current.person_id || current.person || {};
    const email: string | undefined =
      person.email?.[0]?.value ||
      person.primary_email ||
      current.email ||
      current.person_email;

    if (!email) {
      console.error("[WEBHOOK] No email for deal", { dealId });
      return new Response("No email", { status: 200 });
    }

    const leadFirstName: string | undefined =
      person.first_name || (person.name && String(person.name).split(" ")[0]);

    const orgNameRaw: string | null =
      current.org_name || current.org_id?.name || null;

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
    const enrichmentSummary = [
      companyIntro.companyName,
      companyIntro.industry && `Branche: ${companyIntro.industry}`,
      `Kurzprofil: ${companyIntro.oneLiner}`,
      companyIntro.topics.length &&
        `Themen: ${companyIntro.topics.join(", ")}`,
    ]
      .filter(Boolean)
      .join(" | ");

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
