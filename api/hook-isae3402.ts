// api/hook-isae3402.ts
type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  pipeline_id?: number;
  person_name?: string;
  organization_name?: string;
  org_name?: string;
  [k: string]: any; // für Custom Fields
};

// Hilfsfunktion: API-URL mit Token korrekt bauen
function withAuth(url: string) {
  const apiToken = process.env.PD_API_TOKEN;
  const oauth = process.env.PD_OAUTH_TOKEN;
  if (oauth) {
    // OAuth: Header verwenden
    return { url, headers: { Authorization: `Bearer ${oauth}` } };
  }
  // Personal API Token: als Query anhängen
  const sep = url.includes("?") ? "&" : "?";
  return { url: `${url}${sep}api_token=${apiToken}`, headers: {} as Record<string, string> };
}

export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Leichtgewichtige Absicherung über Secret in der URL
    const secret = req.query?.secret;
    if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
      console.log('secret mismatch'); 
      return res.status(401).send('Unauthorized');
    }

    // ENVs
    const PD_API   = process.env.PD_API!;
    const PIPELINE_ID = Number(process.env.PIPELINE_ID);
    const STAGE_ID    = Number(process.env.STAGE_ID);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || '').toLowerCase(); // optional

    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY; // text/longtext
    const F_INTRO  = process.env.FIELD_EMAIL_INTRO;        // text/longtext
    const F_DONE   = process.env.FIELD_AI_ENRICHED;        // yes/no

    if (!PD_API || (!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      console.error('Missing core envs', { PD_API: !!PD_API, token: !!(process.env.PD_API_TOKEN || process.env.PD_OAUTH_TOKEN), PIPELINE_ID, STAGE_ID });
      return res.status(500).send('Missing environment variables');
    }

    const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta  = body?.meta || {};
    const curr: PDDeal = body?.current || {};
    const changes = meta?.changes || {};

    const action = String(meta?.action || '').toLowerCase(); // "updated" | "added" | ...
    const object = String(meta?.object || '').toLowerCase(); // "deal"

    if (object !== 'deal') {
      console.log('ignored (not a deal)', { object, action });
      return res.status(200).send('ignored');
    }

    // 1) Auslösen beim Eintritt in die Ziel-Stage
    const stageChangedToTarget =
      !!changes?.stage_id?.new_value && Number(changes.stage_id.new_value) === STAGE_ID;

    // 2) Optional: auch bei neu angelegtem Deal (wenn er direkt in dieser Stage landet)
    const isAddedInTargetStage = action === 'added' && Number(curr?.stage_id) === STAGE_ID;

    if (!(stageChangedToTarget || isAddedInTargetStage)) {
      console.log('ignored (stage filter)', { action, stageChangedToTarget, isAddedInTargetStage });
      return res.status(200).send('ignored');
    }

    const dealId = Number(meta?.id || curr?.id);
    if (!dealId) {
      console.log('ignored (no dealId)');
      return res.status(200).send('ignored');
    }

    // Deal nachladen (für Pipeline-Check, Custom Fields, Person/Org etc.)
    const getCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const getResp = await fetch(getCfg.url, { headers: getCfg.headers });
    const getText = await getResp.text();
    if (!getResp.ok) {
      console.error('GET deal failed', getResp.status, getText.slice(0, 200));
      return res.status(502).send(`get deal failed ${getResp.status}`);
    }
    const getJson = JSON.parse(getText || '{}');
    const data: PDDeal = getJson?.data || {};

    // Pipeline filtern
    const pipelineMatch = Number(data?.pipeline_id || curr?.pipeline_id) === PIPELINE_ID;
    if (!pipelineMatch) {
      console.log('ignored (pipeline mismatch)', { pipelineId: data?.pipeline_id, PIPELINE_ID });
      return res.status(200).send('ignored');
    }

    // Optionaler Produkt-Trigger: im Titel
    const title = String(data?.title || curr?.title || '').toLowerCase();
    if (PRODUCT_TRIGGER && !title.includes(PRODUCT_TRIGGER)) {
      console.log('ignored (product trigger)', { title, PRODUCT_TRIGGER });
      return res.status(200).send('ignored');
    }

    // Schon bearbeitet?
    let already = false;
    if (F_DONE) {
      const value = (data as any)[F_DONE];
      // Ja/Nein-Felder sind oft "0"/"1" (string) oder boolean
      already = value === 1 || value === '1' || value === true || value === 'true';
    }
    if (already) {
      console.log('already enriched', { dealId });
      return res.status(200).send('already enriched');
    }

    // Platzhalter-Inhalte
    const personName = data?.person_name || curr?.person_name || '';
    const orgName    = data?.organization_name || data?.org_name || curr?.organization_name || curr?.org_name || '';

    const enrichmentSummary =
      `Kurzresearch (Platzhalter):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      `• Produkt: ${PRODUCT_TRIGGER || 'n/a'}\n` +
      `• Need/Anknüpfpunkte: (TODO)`;

    const emailIntro =
      `Hallo ${personName || 'Team'},\n\n` +
      `wir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. ` +
      `Bei ${PRODUCT_TRIGGER || 'unserem Angebot'} geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung. ` +
      `Anbei Whitepaper & Kalenderlink. Welche Zielsetzung verfolgen Sie konkret?\n\n` +
      `Viele Grüße`;

    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO)  updateBody[F_INTRO]  = emailIntro;
    if (F_DONE)   updateBody[F_DONE]   = 1; // als "1" / 1 setzen

    if (Object.keys(updateBody).length === 0) {
      console.log('no custom fields configured — nothing to update, success', { dealId });
      return res.status(200).send('ok (no fields configured)');
    }

    const putCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const upd = await fetch(putCfg.url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(putCfg.headers || {})
      },
      body: JSON.stringify(updateBody)
    });
    const updText = await upd.text();
    console.log('Update deal ->', upd.status, updText.slice(0, 200));
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status}`);

    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
