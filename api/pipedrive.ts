// api/pipedrive.ts
export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Basic Auth
    const auth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`).toString('base64');
    if (auth !== expected) return res.status(401).send('Unauthorized');

    // ENV
    const PD_API   = process.env.PD_API!;
    const PD_TOKEN = process.env.PD_API_TOKEN!;
    const STAGE_QUALIFIED = Number(process.env.STAGE_ID_QUALIFIED); // ID der Stage "Qualified"
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402').toLowerCase();

    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY!; // z.B. cf_...
    const F_INTRO  = process.env.FIELD_EMAIL_INTRO!;        // z.B. cf_...
    const F_DONE   = process.env.FIELD_AI_ENRICHED!;        // z.B. cf_...

    if (!PD_API || !PD_TOKEN || !STAGE_QUALIFIED || !F_ENRICH || !F_INTRO || !F_DONE) {
      console.error('Missing envs'); return res.status(500).send('Missing environment variables');
    }

    // Payload
    const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta  = body?.meta || {};
    const curr  = body?.current || {};
    const action: string = (meta?.action || '').toLowerCase();

    // Nur deal.created (added)
    if (meta?.object !== 'deal' || action !== 'added') {
      console.log('ignored (not deal.added)'); return res.status(200).send('ignored');
    }

    const dealId: number = curr?.id;
    const title: string  = curr?.title || '';
    const stageId: number = Number(curr?.stage_id);

    // Filter: Stage Qualified + Titel enthält "ISAE 3402"
    const match = stageId === STAGE_QUALIFIED && title.toLowerCase().includes(PRODUCT_TRIGGER);
    if (!match) { console.log('ignored (no match)'); return res.status(200).send('ignored'); }

    // Schon verarbeitet?
    const getResp = await fetch(`${PD_API}/deals/${dealId}?api_token=${PD_TOKEN}`);
    const getJson = await getResp.json();
    if (getJson?.data?.[F_DONE]) {
      console.log('already enriched', { dealId }); return res.status(200).send('already enriched');
    }

    // --- Enrichment (Placeholder) ---
    const personName = curr?.person_name || '';
    const orgName    = curr?.organization_name || curr?.org_name || '';
    const enrichmentSummary =
      `Kurzresearch:\n- Person: ${personName || 'n/a'}\n- Unternehmen: ${orgName || 'n/a'}\n- Produkt: ISAE 3402\n- Need: (TODO)\n- Ansatzpunkte: (TODO)`;
    const emailIntro =
      `Hallo ${personName || 'Team'},\n\nwir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. Für ISAE 3402 sehen wir typischen Bedarf bei Audit-Vorbereitung, Kontrollnachweisen und effizientem Vorgehen.\nWhitepaper & Kalenderlink findest du unten. Welche Zielsetzung habt ihr konkret?`;

    // Nur UPDATE – kein POST!
    const updateBody: Record<string, any> = {
      [F_ENRICH]: enrichmentSummary,
      [F_INTRO]: emailIntro,
      [F_DONE]: true
    };

    const upd = await fetch(`${PD_API}/deals/${dealId}?api_token=${PD_TOKEN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody)
    });
    const updText = await upd.text();
    console.log('Update deal ->', upd.status, updText);
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status}: ${updText}`);

    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
