// /api/hook-isae3402.ts

import { domainFromEmail, isFreemailOrDisposable, inferOrgNameFromDomain, hasMX } from '../lib/company';
import { withAuth, pdSearchOrg, pdCreateOrg, pdAttachDealToOrg } from '../lib/pd';

type PDDeal = {
  id: number;
  title?: string;
  stage_id?: number;
  pipeline_id?: number;
  person_id?: number | { value?: number };
  person_name?: string;
  organization_name?: string;
  org_name?: string;
  org_id?: number;
  [k: string]: any;
};

function asNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchSiteMeta(domain?: string) {
  if (!domain) return { title: null as string | null, description: null as string | null };
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' as any });
    const html = await r.text();
    const title = (html.match(/<title>([^<]{0,120})<\/title>/i)?.[1] || '').trim() || null;
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,240})["']/i)?.[1] || '').trim() || null;
    return { title, description: desc };
  } catch { return { title: null, description: null }; }
}

async function generateEmailIntroLLM(input: {
  personName?: string; orgName?: string; product: string;
  websiteTitle?: string | null; websiteDescription?: string | null;
  whitepaper?: string; calendar?: string;
}) {
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const apiKey = process.env.OPENAI_API_KEY;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  const prompt = [
    `Rolle: Senior SDR. Ziel: sehr kurze, persönliche Erstansprache per E-Mail (DE).`,
    `Rahmen: 90–130 Wörter, konkret & sachlich.`,
    `Person: ${input.personName || 'Team'}`,
    `Unternehmen: ${input.orgName || 'Unbekannt'}`,
    `Produkt: ${input.product}`,
    input.websiteTitle ? `Website-Titel: ${input.websiteTitle}` : '',
    input.websiteDescription ? `Website-Description: ${input.websiteDescription}` : '',
    `Pflicht: 1 Relevanzsatz (warum ${input.product} für diese Firma), 1 Outcome-Vorschlag.`,
    `CTA: Whitepaper [${input.whitepaper || ''}] oder 20-Min Termin [${input.calendar || ''}].`,
    `Ausgabeformat:`,
    `SUBJECT: <max 60 Zeichen>`,
    `BODY:\n<Begrüßung + 3–5 Sätze + Links (falls vorhanden) + Sign-off>`,
  ].filter(Boolean).join('\n');

  const base = {
    temperature: 0.2,
    max_tokens: 350,
    messages: [
      { role: 'system', content: 'Du schreibst knappe, personalisierte B2B-Erstansprachen (Deutsch). Keine Halluzination: wenn Infos fehlen, bleib allgemein.' },
      { role: 'user', content: prompt }
    ]
  };

  let resp;
  if (azureKey && azureEndpoint && azureDeployment) {
    resp = await fetch(`${azureEndpoint}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
      body: JSON.stringify(base)
    });
  } else {
    if (!apiKey) throw new Error('OPENAI_API_KEY missing');
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...base, model })
    });
  }

  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content || '';
  const subject = (text.match(/SUBJECT:\s*(.+)/i)?.[1] || '').trim().slice(0, 120);
  const bodyText = (text.split(/BODY:\s*/i)[1] || text).trim();

  const withLinks = bodyText
    .replace('[WHITEPAPER]', input.whitepaper || '')
    .replace('[CALENDAR]', input.calendar || '');

  return { subject, body: withLinks };
}

export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // URL-Secret
    if (!process.env.WEBHOOK_SECRET || req.query?.secret !== process.env.WEBHOOK_SECRET) {
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
    const F_SPAM   = process.env.FIELD_SPAM; // optional Yes/No
    const WHITEPAPER_URL = process.env.WHITEPAPER_URL || '';
    const CALENDAR_URL   = process.env.CALENDAR_URL || '';

    if ((!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      return res.status(500).send('Missing environment variables');
    }

    // Body parsen & v1/v2 normalisieren
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta = body?.meta || {};
    const isV2 = !!body?.data && (meta?.version?.startsWith?.('2') || typeof meta?.entity === 'string');

    const curr: PDDeal = (isV2 ? body?.data : body?.current) || {};
    const changes = isV2 ? {} : (meta?.changes || {});
    const actionRaw = String(meta?.action || meta?.event_action || '').toLowerCase();
    const objectRaw = String((isV2 ? meta?.entity : (meta?.object || meta?.event_object || meta?.model)) || '').toLowerCase();

    const actionN =
      actionRaw === 'create' ? 'added' :
      actionRaw === 'change' ? 'updated' :
      actionRaw === 'delete' ? 'deleted' : actionRaw;

    const objectN = objectRaw || 'deal';
    if (objectN !== 'deal') return res.status(200).send('ignored');

    // Stage/Pipeline-Filter
    const currStageId = asNumber(curr?.stage_id);
    const currPipelineId = asNumber(curr?.pipeline_id);
    const pipelineMatch = currPipelineId === PIPELINE_ID;

    const enteredTargetStage_v1 = actionN === 'updated' && asNumber((changes as any)?.stage_id?.new_value) === STAGE_ID;
    const createdInTargetStage  = actionN === 'added'   && currStageId === STAGE_ID;
    const inTargetStage_v2      = isV2 && (actionN === 'added' || actionN === 'updated') && currStageId === STAGE_ID;

    const stagePass = createdInTargetStage || enteredTargetStage_v1 || inTargetStage_v2;
    if (!stagePass || !pipelineMatch) return res.status(200).send('ignored');

    // Deal-ID ermitteln & laden
    const dealId = asNumber((isV2 ? meta?.entity_id : meta?.id) || curr?.id);
    if (!dealId) return res.status(200).send('ignored');

    const getCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const getResp = await fetch(getCfg.url, { headers: getCfg.headers });
    const getText = await getResp.text();
    if (!getResp.ok) return res.status(502).send(`get deal failed ${getResp.status}`);
    const data: PDDeal = (JSON.parse(getText || '{}')?.data) || {};

    // Titel-/Produkt-Trigger (optional)
    const title = String(data?.title || curr?.title || '').toLowerCase();
    if (PRODUCT_TRIGGER && !title.includes(PRODUCT_TRIGGER)) {
      return res.status(200).send('ignored');
    }

    // Spam/Company-Ermittlung
    let orgName = data.organization_name || data.org_name || '';
    let orgId   = asNumber(data.org_id);

    // Person/E-Mail ziehen
    let emailDomain: string | null = null;
    if (!orgId && data.person_id) {
      const pid = typeof data.person_id === 'object' ? (data.person_id as any).value || 0 : Number(data.person_id);
      if (pid) {
        const cfgP = withAuth(`${PD_API}/persons/${pid}`);
        const pResp = await fetch(cfgP.url, { headers: cfgP.headers });
        if (pResp.ok) {
          const p = (await pResp.json())?.data || {};
          const primaryEmail = Array.isArray(p.email) ? p.email[0]?.value : p.email;
          emailDomain = domainFromEmail(primaryEmail);
          if (!orgName && p.org_name) orgName = p.org_name;
        }
      }
    }

    // Spam-Filter (Freemail/Disposable/MX)
    if (emailDomain && isFreemailOrDisposable(emailDomain)) {
      if (F_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetch(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [F_SPAM]: 1 })
        });
      }
      return res.status(200).send('ok (spam/freemail)');
    }
    if (emailDomain && !(await hasMX(emailDomain))) {
      if (F_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetch(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [F_SPAM]: 1 })
        });
      }
      return res.status(200).send('ok (no_mx)');
    }

    // Falls keine Organisation am Deal hängt → aus Domain ableiten, in PD suchen/erstellen, attachen
    if (!orgId && emailDomain) {
      const inferredName = inferOrgNameFromDomain(emailDomain);
      const hits = await pdSearchOrg(PD_API, inferredName);
      const firstHit = Array.isArray(hits) ? hits[0]?.item : null;
      if (firstHit?.id) {
        orgId = firstHit.id;
        orgName = firstHit.name || inferredName;
      } else {
        const created = await pdCreateOrg(PD_API, inferredName);
        if (created?.id) {
          orgId = created.id;
          orgName = created.name || inferredName;
        }
      }
      if (orgId) await pdAttachDealToOrg(PD_API, dealId, orgId);
    }

    // Schon angereichert?
    if (process.env.FIELD_AI_ENRICHED) {
      const v = (data as any)[process.env.FIELD_AI_ENRICHED];
      const already = v === 1 || v === '1' || v === true || v === 'true';
      if (already) return res.status(200).send('already enriched');
    }

    // Website-Meta als kostengünstiger Kontext
    let websiteTitle: string | null = null;
    let websiteDescription: string | null = null;
    if (emailDomain) {
      const metaSite = await fetchSiteMeta(emailDomain);
      websiteTitle = metaSite.title;
      websiteDescription = metaSite.description;
    }

    const personName = data?.person_name || curr?.person_name || '';
    const productName = process.env.PRODUCT_TRIGGER || 'unser Angebot';

    // LLM-Intro generieren
    let emailIntro = '';
    try {
      const llm = await generateEmailIntroLLM({
        personName, orgName, product: productName,
        websiteTitle, websiteDescription,
        whitepaper: WHITEPAPER_URL, calendar: CALENDAR_URL
      });
      emailIntro = llm?.body || '';
    } catch (e: any) {
      // Fallback
      emailIntro =
        `Hallo ${personName || 'Team'},\n\n` +
        `wir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. ` +
        `Bei ${productName} geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung.\n\n` +
        (WHITEPAPER_URL ? `Whitepaper: ${WHITEPAPER_URL}\n` : '') +
        (CALENDAR_URL ? `Kalender: ${CALENDAR_URL}\n` : '') +
        `Welche Zielsetzung verfolgen Sie konkret?\n\nViele Grüße`;
    }

    // Summary (kurz)
    const enrichmentSummary =
      `Kurzresearch (automatisch):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      (websiteTitle ? `• Website: ${websiteTitle}\n` : '') +
      (websiteDescription ? `• Beschreibung: ${websiteDescription}\n` : '') +
      `• Produkt: ${productName}\n` +
      `• Ansatzpunkte: (TODO)`;

    // Update-Body vorbereiten
    const updateBody: Record<string, any> = {};
    if (F_ENRICH) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO)  updateBody[F_INTRO]  = emailIntro;
    if (F_DONE)   updateBody[F_DONE]   = 1;

    if (Object.keys(updateBody).length === 0) return res.status(200).send('ok (no fields configured)');

    const putCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const upd = await fetch(putCfg.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(putCfg.headers || {}) },
      body: JSON.stringify(updateBody)
    });
    const updText = await upd.text();
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status} ${updText.slice(0,120)}`);

    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
