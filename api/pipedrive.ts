// // Keine Imports nötig – Node 18/20 hat global fetch

// // Umgebungsvariablen
// const PD_API = process.env.PD_API!;
// const PD_TOKEN = process.env.PD_API_TOKEN!;
// const PIPELINE_ID = process.env.PIPELINE_ID!;
// const STAGE_ID = process.env.STAGE_ID!;
// const PRODUCT_NAME = process.env.PRODUCT_NAME || 'BSI C5';
// const WHITEPAPER_URL = process.env.WHITEPAPER_URL!;
// const CALENDAR_URL = process.env.CALENDAR_URL!;
// const BASIC_USER = process.env.BASIC_USER!;
// const BASIC_PASS = process.env.BASIC_PASS!;

// // simple Idempotenz (Demo)
// const seen = new Set<string>();

// export default async function handler(req: any, res: any) {
//   // Basic Auth prüfen
//   const auth = req.headers.authorization || '';
//   const valid =
//     auth.startsWith('Basic ') &&
//     Buffer.from(auth.split(' ')[1], 'base64').toString('utf8') === `${BASIC_USER}:${BASIC_PASS}`;
//   if (!valid) {
//     res.setHeader('WWW-Authenticate', 'Basic realm="pipedrive"');
//     return res.status(401).send('Unauthorized');
//   }

//   if (req.method !== 'POST') return res.status(405).send('Method not allowed');

//   const body = req.body || {};
//   const meta = body.meta || {};
//   const current = body.current || {};
//   const eventId = meta.id || `${Date.now()}`;

//   if (seen.has(eventId)) return res.status(200).send('duplicate');
//   seen.add(eventId);

//   try {
//     // nur unser Formular bedienen (anpassen falls nötig)
//     const formName: string = current?.title || '';
//     if (!formName.toLowerCase().includes('bsi c5')) {
//       return res.status(200).send('ignored');
//     }

//     const personName: string = current?.person_name || 'Kontakt';
//     const orgName: string = current?.organization_name || '';
//     const email: string = current?.email || current?.person_email || '';
//     const domain = email.includes('@') ? email.split('@')[1] : '';

//     // Deal anlegen
//     const createDealResp = await fetch(`${PD_API}/deals?api_token=${PD_TOKEN}`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         title: `Inbound: ${personName}${orgName ? ' @ ' + orgName : ''}`,
//         pipeline_id: Number(PIPELINE_ID),
//         stage_id: Number(STAGE_ID),
//         product_form: PRODUCT_NAME,
//         whitepaper_url: WHITEPAPER_URL,
//         calendar_url: CALENDAR_URL
//       })
//     });
//     const createDealJson: any = await createDealResp.json();
//     const dealId = createDealJson?.data?.id;
//     if (!dealId) throw new Error('Deal creation failed');

//     // Personalisierung
//     const bullets = [
//       orgName ? `Unternehmen: ${orgName}` : 'Unternehmen: (keine Angabe)',
//       domain ? `Domain: ${domain}` : 'Domain: (unbekannt)',
//       `Hypothese: Interesse an ${PRODUCT_NAME} wegen Compliance/Marktzugang`
//     ];
//     const intro =
//       `vielen Dank für eure Anfrage zu ${PRODUCT_NAME}. ` +
//       `Oft geht es um Klarheit bei Umfang/Timeline und typische Stolpersteine. ` +
//       `Gern teile ich die wichtigsten Meilensteine und eine kompakte Roadmap.`;

//     // Deal updaten
//     await fetch(`${PD_API}/deals/${dealId}?api_token=${PD_TOKEN}`, {
//       method: 'PUT',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         enrichment_summary: bullets.join('\n• '),
//         email_intro_personalized: intro
//       })
//     });

//     return res.status(200).send('ok');
//   } catch (err) {
//     console.error(err);
//     return res.status(200).send('ok'); // 2xx, damit Pipedrive nicht unendlich retried
//   }
// }
// api/pipedrive.ts
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Basic Auth prüfen
    const auth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer
      .from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`)
      .toString('base64');

    if (auth !== expected) return res.status(401).send('Unauthorized');

    const PD_API = process.env.PD_API;           // z.B. https://deinaccount.pipedrive.com/api/v1
    const PD_TOKEN = process.env.PD_API_TOKEN;   // dein API Token

    if (!PD_API || !PD_TOKEN) {
      console.error('ENV missing', { PD_API: !!PD_API, PD_TOKEN: !!PD_TOKEN });
      return res.status(500).send('Missing PD_API or PD_API_TOKEN');
    }

    // Titel aus Payload oder Fallback
    let body: any = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
    const personName = body?.current?.person_name || '';
    const orgName    = body?.current?.organization_name || '';
    const titleIn    = body?.current?.title || '';
    const title = titleIn || `Inbound${personName ? ' - ' + personName : ''}${orgName ? ' @ ' + orgName : ''}` || 'Inbound Testdeal';

    // ➊ Deal minimal erstellen (nur title)
    const createResp = await fetch(`${PD_API}/deals?api_token=${PD_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        pipeline_id: Number(process.env.PIPELINE_ID),
        stage_id: Number(process.env.STAGE_ID)
      })

    });

    const createText = await createResp.text();
    console.log('Create /deals ->', createResp.status, createText);

    // Fehlerdurchreiche mit Originaltext
    if (!createResp.ok) {
      return res.status(502).send(`Pipedrive create failed ${createResp.status}: ${createText}`);
    }

    let createJson: any = {};
    try { createJson = JSON.parse(createText || '{}'); } catch {}
    const dealId = createJson?.data?.id;

    if (!dealId) {
      return res.status(502).send(`Pipedrive returned no id: ${createText}`);
    }

    // Erfolg
    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
