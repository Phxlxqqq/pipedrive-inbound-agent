// api/hook-isae3402.ts

type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  pipeline_id?: number;
  person_name?: string;
  organization_name?: string;
  org_name?: string;
};

export default async function handler(req: any, res: any) {
  try {
    // Notbremse
    if (process.env.KILL_SWITCH === '1') {
      console.log('kill-switch active');
      return res.status(200).send('noop (kill switch)');
    }

    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Basic Auth
    const auth = req.headers.authorization || '';
    const expected =
      'Basic ' + Buffer.from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`).toString('base64');
    if (auth !== expected) {
      console.log('auth failed');
      return res.status(401).send('Unauthorized');
    }

    // ENVs
    const PD_API   = process.env.PD_API!;
    const PD_TOKEN = process.env.PD_API_TOKEN!;

    const PIPELINE_ID = Number(process.env.PIPELINE_ID); // die Pipeline, in der die Webform-Deals landen (z. B. Leads)
    const STAGE_ID    = Number(process.env.STAGE_ID);    // die "Qualified"-Stage in genau dieser Pipeline
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402').toLowerCase();

    // optional: Custom-Field-Keys (cf_…)
    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY; // text/longtext
    const F_INTRO  = process.env.FIELD_EMAIL_INTRO;        // text/longtext
    const F_DONE   = process.env.FIELD_AI_ENRICHED;        // yes/no (boolean)

    if (!PD_API || !PD_TOKEN || !PIPELINE_ID || !STAGE_ID) {
      console.error('Missing core envs', { PD_API: !!PD_API, PD_TOKEN: !!PD_TOKEN, PIPELINE_ID, STAGE_ID });
      return res.status(500).send('Missing environment variables');
    }

    // Payload
    const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta  = body?.meta || {};
    const curr: PDDeal = body?.current || {};

    const action = String(meta?.action || '').toLowerCase();
    const object = String(meta?.object || '').toLowerCase();

    // Nur Deal.Created (added)
    if (object !== 'deal' || action !== 'added') {
      console.log('ignored (not deal.added)', { object, action });
      return res.status(200).send('ignored');
    }

    const dealId     = Number(curr?.id);
    const title      = String(curr?.title || '');
    const stageId    = Number(curr?.stage_id);
    const pipelineId = Number(curr?.pipeline_id);

    // Filter: richtige Pipeline + richtige Stage + Titel enthält Produkt
    const titleMatch    = title.toLowerCase().includes(PRODUCT_TRIGGER);
    const stageMatch    = stageId === STAGE_ID;
    const pipelineMatch = pipelineId === PIPELINE_ID;

    if (!titleMatch || !stageMatch || !pipelineMatch) {
      console.log('ignored (no match)', { title, stageId, pipelineId, titleMatch, stageMatch, pipelineMatch });
      return res.status(200).send('ignored');
    }

    // Deal laden (Flag prüfen)
    const getResp = await fetch(`${PD_API}/deals/${dealId}`, {
      headers: { Authorization: `Bearer ${PD_TOKEN}` }
    });
    const getText = await getResp.text();
    if (!getResp.ok) {
      console.error('GET deal failed', getResp.status, getText.slice(0, 200));
      return res.status(502).send(`get deal failed ${getResp.status}`);
    }
    const getJson = JSON.parse(getText || '{}');
    const data = getJson?.data || {};
    const already = F_DONE ? data[F_DONE] : false;
    if (already) {
      console.log('already enriched', { dealId });
      return res.status(200).send('already enriched');
    }

    // Platzhalter-Inhalte (bis KI live ist)
    const personName = curr?.person_name || '';
    const orgName    = curr?.organization_name || curr?.org_name || '';

    const enrichmentSummary =
      `Kurzresearch (Platzhalter):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      `• Produkt: ISAE 3402\n` +
      `• Need/Anknüpfpunkte: (TODO)`;

    const emailIntro =
      `Hallo ${personName || 'Team'},\n\n` +
      `wir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. ` +
      `Bei ISAE 3402 geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung. ` +
      `Anbei Whitepaper & Kalenderlink. Welche Zielsetzung verfolgen Sie konkret?\n\n` +
      `Viele Grüße`;

    // Update-Body nur mit vorhandenen Feldern
    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO)  updateBody[F_INTRO]  = emailIntro;
    if (F_DONE)   updateBody[F_DONE]   = true;

    if (Object.keys(updateBody).length === 0) {
      console.log('no custom fields configured — nothing to update, success', { dealId });
      return res.status(200).send('ok (no fields configured)');
    }

    // Nur UPDATE – kein CREATE!
    const upd = await fetch(`${PD_API}/deals/${dealId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PD_TOKEN}`
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
