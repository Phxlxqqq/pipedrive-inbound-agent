// api/hook-isae3402.ts

type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  person_name?: string;
  organization_name?: string;
  org_name?: string;
};

export default async function handler(req: any, res: any) {
  try {
    // Kill-Switch (Notbremse)
    if (process.env.KILL_SWITCH === '1') {
      console.log('kill-switch active');
      return res.status(200).send('noop (kill switch)');
    }

    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // ---- Basic Auth prüfen
    const auth = req.headers.authorization || '';
    const expected =
      'Basic ' +
      Buffer.from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`).toString('base64');

    if (auth !== expected) {
      console.log('auth failed');
      return res.status(401).send('Unauthorized');
    }

    // ---- ENV laden
    const PD_API = process.env.PD_API!;
    const PD_TOKEN = process.env.PD_API_TOKEN!;
    const STAGE_QUALIFIED = Number(process.env.STAGE_ID_QUALIFIED);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402').toLowerCase();

    // Custom Field Keys (optional – wenn nicht gesetzt, werden sie einfach übersprungen)
    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY; // z.B. cf_abc...
    const F_INTRO = process.env.FIELD_EMAIL_INTRO;         // z.B. cf_def...
    const F_DONE = process.env.FIELD_AI_ENRICHED;          // z.B. cf_xyz... (Checkbox/YesNo)

    if (!PD_API || !PD_TOKEN || !STAGE_QUALIFIED) {
      console.error('Missing core envs', {
        PD_API: !!PD_API,
        PD_TOKEN: !!PD_TOKEN,
        STAGE_QUALIFIED,
      });
      return res.status(500).send('Missing environment variables');
    }

    // ---- Payload parsen
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta = body?.meta || {};
    const curr: PDDeal = body?.current || {};

    const action = String(meta?.action || '').toLowerCase();
    const object = String(meta?.object || '').toLowerCase();

    // nur deal.created (added) verarbeiten
    if (object !== 'deal' || action !== 'added') {
      console.log('ignored (not deal.added)', { object, action });
      return res.status(200).send('ignored');
    }

    const dealId = Number(curr?.id);
    const title = String(curr?.title || '');
    const stageId = Number(curr?.stage_id);

    // Filter: Stage = Qualified + Titel enthält "ISAE 3402"
    const titleMatch = title.toLowerCase().includes(PRODUCT_TRIGGER);
    const stageMatch = stageId === STAGE_QUALIFIED;

    if (!titleMatch || !stageMatch) {
      console.log('ignored (no match)', { title, stageId, titleMatch, stageMatch });
      return res.status(200).send('ignored');
    }

    // ---- Deal laden (um Flag zu prüfen)
    const getResp = await fetch(`${PD_API}/deals/${dealId}`, {
      headers: { Authorization: `Bearer ${PD_TOKEN}` },
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

    // ---- Platzhalter-Inhalte (bis KI aktiv ist)
    const personName = curr?.person_name || '';
    const orgName = curr?.organization_name || curr?.org_name || '';

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

    // ---- Update-Body nur mit Feldern, die wirklich vorhanden sind
    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO) updateBody[F_INTRO] = emailIntro;
    if (F_DONE) updateBody[F_DONE] = true;

    if (Object.keys(updateBody).length === 0) {
      console.log('no custom fields configured — nothing to update, but success', { dealId });
      return res.status(200).send('ok (no fields configured)');
    }

    // ---- Deal updaten (PUT) – KEIN CREATE!
    const upd = await fetch(`${PD_API}/deals/${dealId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PD_TOKEN}`,
      },
      body: JSON.stringify(updateBody),
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
