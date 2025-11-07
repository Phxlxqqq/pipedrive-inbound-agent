// /api/hook-isae3402.ts

type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  pipeline_id?: number;
  person_name?: string;
  organization_name?: string;
  org_name?: string;
  [k: string]: any; // erlaubt Zugriff auf Custom Fields (cf_…)
};

// ---- Auth-Helfer: Personal Token -> ?api_token=..., OAuth -> Bearer ----
function withAuth(url: string) {
  const oauth = process.env.PD_OAUTH_TOKEN;
  if (oauth) return { url, headers: { Authorization: `Bearer ${oauth}` } };
  const sep = url.includes("?") ? "&" : "?";
  return { url: `${url}${sep}api_token=${process.env.PD_API_TOKEN}`, headers: {} as Record<string, string> };
}

export default async function handler(req: any, res: any) {
  try {
    // Notbremse
    if (process.env.KILL_SWITCH === "1") return res.status(200).send("noop (kill switch)");
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    // Leichtgewichtige Absicherung via URL-Secret
    if (!process.env.WEBHOOK_SECRET || req.query?.secret !== process.env.WEBHOOK_SECRET) {
      console.log("secret mismatch");
      return res.status(401).send("Unauthorized");
    }

    // ENVs
    const PD_API = process.env.PD_API || "https://api.pipedrive.com/v1";
    const PIPELINE_ID = Number(process.env.PIPELINE_ID);
    const STAGE_ID = Number(process.env.STAGE_ID);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || "ISAE 3402").toLowerCase();

    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY; // cf_xxx, Text/Longtext
    const F_INTRO = process.env.FIELD_EMAIL_INTRO;         // cf_xxx, Text/Longtext
    const F_DONE = process.env.FIELD_AI_ENRICHED;          // cf_xxx, Yes/No

    const WHITEPAPER_URL = process.env.WHITEPAPER_URL || "";
    const CALENDAR_URL = process.env.CALENDAR_URL || "";

    if ((!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      console.error("Missing core envs", {
        token: !!(process.env.PD_API_TOKEN || process.env.PD_OAUTH_TOKEN),
        PIPELINE_ID,
        STAGE_ID,
      });
      return res.status(500).send("Missing environment variables");
    }

    // Body parsen

    
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    console.log("🔍 Incoming Webhook Payload:\n", JSON.stringify(body, null, 2));


    const meta = body?.meta || {};
    const curr: PDDeal = body?.current || {};
    const changes = meta?.changes || {};

    // ---- Events normalisieren: create/change/delete => added/updated/deleted ----
    const actionRaw = String(meta?.action || meta?.event_action || "").toLowerCase();
    const objectRaw = String(meta?.object || meta?.event_object || meta?.model || "").toLowerCase();

    const actionN =
      actionRaw === "create" ? "added" :
      actionRaw === "change" ? "updated" :
      actionRaw === "delete" ? "deleted" : (actionRaw || String(meta?.action || "").toLowerCase());

    const objectN = objectRaw || "deal"; // einige UIs liefern kein object; wir prüfen zusätzlich unten

    if (objectN !== "deal") {
      console.log("ignored (not deal)", { object: objectN, action: actionN });
      return res.status(200).send("ignored");
    }

    // ---- Stage-Filter: (A) neu in Stage angelegt  (B) per change in Stage verschoben ----
    const inTargetOnAdd = actionN === "added" && Number(curr?.stage_id) === STAGE_ID;
    const movedToTargetUpd = actionN === "updated" && Number(changes?.stage_id?.new_value) === STAGE_ID;

    if (!(inTargetOnAdd || movedToTargetUpd)) {
      console.log("ignored (stage)", { actionN, currStage: curr?.stage_id, change: changes?.stage_id });
      return res.status(200).send("ignored");
    }

    const dealId = Number(meta?.id || curr?.id);
    if (!dealId) {
      console.log("ignored (no deal id)");
      return res.status(200).send("ignored");
    }

    // ---- Deal laden (für Pipeline, Person/Org, Custom Fields) ----
    const getCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const getResp = await fetch(getCfg.url, { headers: getCfg.headers });
    const getText = await getResp.text();
    if (!getResp.ok) {
      console.error("GET deal failed", getResp.status, getText.slice(0, 300));
      return res.status(502).send(`get deal failed ${getResp.status}`);
    }
    const getJson = JSON.parse(getText || "{}");
    const data: PDDeal = getJson?.data || {};

    // Pipeline-Check
    const pipelineMatch = Number(data?.pipeline_id || curr?.pipeline_id) === PIPELINE_ID;
    if (!pipelineMatch) {
      console.log("ignored (pipeline mismatch)", { got: data?.pipeline_id || curr?.pipeline_id, need: PIPELINE_ID });
      return res.status(200).send("ignored");
    }

    // Produkt/Titel-Trigger (optional)
    const title = String(data?.title || curr?.title || "").toLowerCase();
    if (PRODUCT_TRIGGER && !title.includes(PRODUCT_TRIGGER)) {
      console.log("ignored (product trigger)", { title, PRODUCT_TRIGGER });
      return res.status(200).send("ignored");
    }

    // Bereits angereichert?
    let already = false;
    if (F_DONE) {
      const v = (data as any)[F_DONE];
      already = v === 1 || v === "1" || v === true || v === "true";
    }
    if (already) {
      console.log("already enriched", { dealId });
      return res.status(200).send("already enriched");
    }

    // ---- Inhalte generieren (Platzhalter) ----
    const personName = data?.person_name || curr?.person_name || "";
    const orgName = data?.organization_name || data?.org_name || curr?.organization_name || curr?.org_name || "";

    const enrichmentSummary =
      `Kurzresearch (Platzhalter):\n` +
      `• Person: ${personName || "n/a"}\n` +
      `• Unternehmen: ${orgName || "n/a"}\n` +
      `• Produkt: ${PRODUCT_TRIGGER || "n/a"}\n` +
      `• Need/Anknüpfpunkte: (TODO)`;

    const links =
      [WHITEPAPER_URL ? `Whitepaper: ${WHITEPAPER_URL}` : "", CALENDAR_URL ? `Kalender: ${CALENDAR_URL}` : ""]
        .filter(Boolean)
        .join("\n");

    const emailIntro =
      `Hallo ${personName || "Team"},\n\n` +
      `wir haben ${orgName || "Ihr Unternehmen"} kurz angesehen. ` +
      `Bei ${PRODUCT_TRIGGER || "unserem Angebot"} geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung.\n\n` +
      (links ? `${links}\n\n` : "") +
      `Welche Zielsetzung verfolgen Sie konkret?\n\n` +
      `Viele Grüße`;

    // ---- Update vorbereiten ----
    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO)  updateBody[F_INTRO]  = emailIntro;
    if (F_DONE)   updateBody[F_DONE]   = 1;

    if (Object.keys(updateBody).length === 0) {
      console.log("no custom fields configured — nothing to update, success", { dealId });
      return res.status(200).send("ok (no fields configured)");
    }

    // ---- Deal aktualisieren ----
    const putCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const upd = await fetch(putCfg.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(putCfg.headers || {}) },
      body: JSON.stringify(updateBody),
    });
    const updText = await upd.text();
    console.log("Update deal ->", upd.status, updText.slice(0, 300));
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status}`);

    return res.status(200).send("ok");
  } catch (e: any) {
    console.error("Unhandled error:", e);
    return res.status(500).send(e?.message || "error");
  }
}
