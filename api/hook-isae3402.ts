// /api/hook-isae3402.ts

type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  pipeline_id?: number;
  person_name?: string;
  organization_name?: string;
  org_name?: string;
  [k: string]: any;
};

// Auth-Helfer: Personal Token -> ?api_token=..., OAuth -> Bearer
function withAuth(url: string) {
  const oauth = process.env.PD_OAUTH_TOKEN;
  if (oauth) return { url, headers: { Authorization: `Bearer ${oauth}` } };
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}api_token=${process.env.PD_API_TOKEN}`, headers: {} as Record<string, string> };
}

export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Secret prüfen
    if (!process.env.WEBHOOK_SECRET || req.query?.secret !== process.env.WEBHOOK_SECRET) {
      console.log('secret mismatch');
      return res.status(401).send('Unauthorized');
    }

    // ENVs
    const PD_API = process.env.PD_API || 'https://api.pipedrive.com/v1';
    const PIPELINE_ID = Number(process.env.PIPELINE_ID);
    const STAGE_ID = Number(process.env.STAGE_ID);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402').toLowerCase();
    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY;
    const F_INTRO  = process.env.FIELD_EMAIL_INTRO;
    const F_DONE   = process.env.FIELD_AI_ENRICHED;
    const WHITEPAPER_URL = process.env.WHITEPAPER_URL || '';
    const CALENDAR_URL   = process.env.CALENDAR_URL || '';

    if ((!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      console.error('Missing core envs', {
        token: !!(process.env.PD_API_TOKEN || process.env.PD_OAUTH_TOKEN),
        PIPELINE_ID, STAGE_ID
      });
      return res.status(500).send('Missing environment variables');
    }

    // Body parsen + v1/v2 normalisieren
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    // console.log('🔍 Incoming Webhook Payload:\n', JSON.stringify(body, null, 2)); // ← bei Bedarf wieder aktivieren

    const meta = body?.meta || {};
    const isV2 = !!body?.data && (meta?.version?.startsWith?.('2') || typeof meta?.entity === 'string');

    // Quelle für "aktuellen Datensatz"
    const curr: PDDeal = (isV2 ? body?.data : body?.current) || {};
    const previous: any = (isV2 ? body?.previous : body?.previous) || {};
    const changes = isV2 ? {} : (meta?.changes || {});

    // Action/Object normalisieren
    const actionRaw = String(meta?.action || meta?.event_action || '').toLowerCase();
    const objectRaw = String(
      (isV2 ? meta?.entity : (meta?.object || meta?.event_object || meta?.model)) || ''
    ).toLowerCase();

    const actionN =
      actionRaw === 'create' ? 'added' :
      actionRaw === 'change' ? 'updated' :
      actionRaw === 'delete' ? 'deleted' : actionRaw;

    const objectN = objectRaw || 'deal';
    if (objectN !== 'deal') {
      console.log('ignored (not deal)', { object: objectN, action: actionN });
      return res.status(200).send('ignored');
    }

    // Stage/Pipeline ermitteln
    const currStageId = Number(curr?.stage_id);
    const currPipelineId = Number(curr?.pipeline_id);
    const pipelineMatch = currPipelineId === PIPELINE_ID;

    // „Eintritt in Ziel-Stage“ erkennen
    // v1: echte Differenz über meta.changes.stage_id
    // v2: keine Deltas → wir werten „liegt (jetzt) in Ziel-Stage“ als Trigger
    const enteredTargetStage_v1 = actionN === 'updated' && Number((changes as any)?.stage_id?.new_value) === STAGE_ID;
    const createdInTargetStage  = actionN === 'added'   && currStageId === STAGE_ID;
    const inTargetStage_v2      = isV2 && (actionN === 'added' || actionN === 'updated') && currStageId === STAGE_ID;

    const stagePass = createdInTargetStage || enteredTargetStage_v1 || inTargetStage_v2;
    if (!stagePass || !pipelineMatch) {
      console.log('ignored (stage/pipeline)', { actionN, currStage: currStageId, currPipelineId, STAGE_ID, PIPELINE_ID, isV2 });
      return res.status(200).send('ignored');
    }

    // Deal-ID
    const dealId = Number((isV2 ? meta?.entity_id : meta?.id) || curr?.id);
    if (!dealId) {
      console.log('ignored (no deal id)');
      return res.status(200).send('ignored');
    }

    // Deal laden (für Namen, Custom-Fields, Sicherheit)
    const getCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const getResp = await fetch(getCfg.url, { headers: getCfg.headers });
    const getText = await getResp.text();
    if (!getResp.ok) {
      console.error('GET deal failed', getResp.status, getText.slice(0, 300));
      return res.status(502).send(`get deal failed ${getResp.status}`);
    }
    const getJson = JSON.parse(getText || '{}');
    const data: PDDeal = getJson?.data || {};

    // Titel-/Produkt-Trigger (optional)
    const title = String(data?.title || curr?.title || '').toLowerCase();
    if (PRODUCT_TRIGGER && !title.includes(PRODUCT_TRIGGER)) {
      console.log('ignored (product trigger)', { title, PRODUCT_TRIGGER });
      return res.status(200).send('ignored');
    }

    // Schon angereichert?
    let already = false;
    if (F_DONE) {
      const v = (data as any)[F_DONE];
      already = v === 1 || v === '1' || v === true || v === 'true';
    }
    if (already) {
      console.log('already enriched', { dealId });
      return res.status(200).send('already enriched');
    }

    // Inhalte (Platzhalter)
    const personName = data?.person_name || curr?.person_name || '';
    const orgName    = data?.organization_name || data?.org_name || curr?.organization_name || curr?.org_name || '';

    const enrichmentSummary =
      `Kurzresearch (Platzhalter):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      `• Produkt: ${PRODUCT_TRIGGER || 'n/a'}\n` +
      `• Need/Anknüpfpunkte: (TODO)`;

    const links = [WHITEPAPER_URL ? `Whitepaper: ${WHITEPAPER_URL}` : '', CALENDAR_URL ? `Kalender: ${CALENDAR_URL}` : '']
      .filter(Boolean)
      .join('\n');

    const emailIntro =
      `Hallo ${personName || 'Team'},\n\n` +
      `wir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. ` +
      `Bei ${PRODUCT_TRIGGER || 'unserem Angebot'} geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung.\n\n` +
      (links ? `${links}\n\n` : '') +
      `Welche Zielsetzung verfolgen Sie konkret?\n\n` +
      `Viele Grüße`;

    // Update-Body
    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO)  updateBody[F_INTRO]  = emailIntro;
    if (F_DONE)   updateBody[F_DONE]   = 1;

    if (Object.keys(updateBody).length === 0) {
      console.log('no custom fields configured — nothing to update', { dealId });
      return res.status(200).send('ok (no fields configured)');
    }

    // Deal aktualisieren
    const putCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const upd = await fetch(putCfg.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(putCfg.headers || {}) },
      body: JSON.stringify(updateBody)
    });
    const updText = await upd.text();
    console.log('Update deal ->', upd.status, updText.slice(0, 300));
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status}`);

    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
