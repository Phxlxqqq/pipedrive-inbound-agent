// api/pipedrive-webhook/route.ts

import { env } from "../../lib/env";
import { buildCompanyIntro } from "../../lib/companyEnricher";
import { generateFollowupMails } from "../../lib/mailGenerator";
import { updateDeal } from "../../lib/pipedrive";


export async function POST(req: Request) {
  // Secret über Query-Parameter prüfen: ?secret=WEBHOOK_SECRET
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");

  if (secret !== env.webhookSecret) {
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json();
  const current = payload.current || payload.data || payload.deal;

  if (!current) {
    console.error("No deal in payload", payload);
    return new Response("No deal", { status: 400 });
  }

  const dealId: number = current.id;

  // Optional: Pipeline/Stage Filter
  if (env.pipelineId && String(current.pipeline_id) !== env.pipelineId) {
    return new Response("Ignored (pipeline)", { status: 200 });
  }
  if (env.stageId && String(current.stage_id) !== env.stageId) {
    return new Response("Ignored (stage)", { status: 200 });
  }

  const webformTitle: string =
    current.title || current.subject || "Anfrage über Webformular";

  // Optional: Produkt-Filter
  if (env.productTrigger && current.product_name) {
    const productName = String(current.product_name);
    if (!productName.includes(env.productTrigger)) {
      return new Response("Ignored (product)", { status: 200 });
    }
  }

  const person = current.person_id || current.person || {};
  const email: string | undefined =
    person.email?.[0]?.value ||
    person.primary_email ||
    current.email;

  if (!email) {
    console.error("No email for deal", dealId);
    return new Response("No email", { status: 200 });
  }

  const leadFirstName: string | undefined =
    person.first_name || person.name?.split(" ")[0];

  const orgNameRaw: string | null =
    current.org_name || current.org_id?.name || null;

  // 1) Company-Enrichment über Brave
  const companyIntro = await buildCompanyIntro({
    email,
    orgNameRaw,
  });

  // 2) Follow-up-Mails generieren
  const mails = await generateFollowupMails({
    webformTitle,
    leadEmail: email,
    leadFirstName,
    companyIntro,
  });

  // 3) Enrichment-Summary für Pipedrive
  const enrichmentSummary = [
    companyIntro.companyName,
    companyIntro.industry && `Branche: ${companyIntro.industry}`,
    `Kurzprofil: ${companyIntro.oneLiner}`,
    companyIntro.topics.length &&
      `Themen: ${companyIntro.topics.join(", ")}`,
  ]
    .filter(Boolean)
    .join(" | ");

  // 4) Deal-Felder schreiben
  await updateDeal(dealId, {
    [env.fields.enrichmentSummary]: enrichmentSummary,
    [env.fields.companyIndustry]: companyIntro.industry ?? "",
    [env.fields.emailIntro1]: mails.first,
    [env.fields.emailIntro2]: mails.second,
    [env.fields.emailIntro3]: mails.third,
  });

  return new Response("ok", { status: 200 });
}
