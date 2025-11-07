// /api/hook-isae3402.ts
// ENVs (Vercel): PD_API, PD_API_TOKEN|PD_OAUTH_TOKEN, PIPELINE_ID, STAGE_ID, WEBHOOK_SECRET,
// FIELD_ENRICHMENT_SUMMARY, FIELD_EMAIL_INTRO, FIELD_AI_ENRICHED, FIELD_SPAM (optional),
// OPENAI_API_KEY, LLM_MODEL (optional), WHITEPAPER_URL, CALENDAR_URL, PRODUCT_TRIGGER

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
  custom_fields?: Record<string, any>;
  [k: string]: any;
};

function asNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// --- Website Signals for better personalization ---
async function fetchText(url: string) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' as any, cache: 'no-store' as any });
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  } catch { return ''; }
}

async function gatherCompanySignals(domain: string) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const paths = ['', '/about', '/security', '/compliance', '/legal', '/gdpr', '/trust', '/soc', '/audit'];
  const texts = await Promise.all(paths.map(p => fetchText(base.replace(/\/$/, '') + p)));
  const joined = texts.filter(Boolean).join(' \n').slice(0, 8000);

  const lower = joined.toLowerCase();
  const signals: string[] = [];
  const add = (k: string) => { if (!signals.includes(k)) signals.push(k); };
  if (lower.includes('iso 27001')) add('ISO 27001');
  if (lower.includes('soc 1')) add('SOC 1');
  if (lower.includes('soc 2')) add('SOC 2');
  if (lower.includes('bsi c5')) add('BSI C5');
  if (lower.includes('gdpr') || lower.includes('dsgvo')) add('GDPR/DSGVO');
  if (lower.includes('sla')) add('SLA/Verfügbarkeiten');
  if (lower.includes('audit')) add('Audit/Prüfung');
  if (lower.includes('controls') || lower.includes('kontrollen')) add('Interne Kontrollen');
  if (lower.includes('processor') || lower.includes('auftragsverarbeitung')) add('Auftragsverarbeitung');
  if (lower.includes('cloud')) add('Cloud-Service');
  if (lower.includes('enterprise')) add('Enterprise-Kunden');
  if (lower.includes('finance') || lower.includes('finanz')) add('Finanzbezug');

  const snippet = joined.slice(0, 1200);
  return { snippet, signals };
}

// --- LLM email intro ---
async function generateEmailIntroLLM(input: {
  personName?: string; orgName?: string; product: string;
  signalList?: string; siteSnippet?: string;
  whitepaper?: string; calendar?: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model  = process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const prompt = [
    `Schreibe eine kurze, präzise B2B-Erstansprache (Deutsch).`,
    `70–95 Wörter. Keine Superlative, kein Marketing-Sprech, keine Bulletpoints, kein Emoji.`,
    `Aufgabe: Erkläre knapp, WARUM ${input.orgName || 'das Unternehmen'} ${input.product} benötigen könnte.`,
    `Nutze nur Hinweise aus "Signale" und "Auszug". Wenn unklar, vorsichtig formulieren (z. B. "häufig relevant, wenn …").`,
    `Person: ${input.personName || 'Team'}`,
    `Unternehmen: ${input.orgName || 'Unbekannt'}`,
    input.signalList ? `Signale: ${input.signalList}` : '',
    input.siteSnippet ? `Auszug: ${input.siteSnippet}` : '',
    `Struktur: 1) Relevanz 2) konkreter Nutzen ${input.product} 3) Beispiel (z. B. Change-/Access-/Operations-Kontrollen) 4) EIN CTA (Link).`,
    `CTA: entweder Whitepaper [${input.whitepaper || ''}] ODER 20-Min-Termin [${input.calendar || ''}] – aber nicht beides.`,
    `Stil: direkt, klar, ohne Füllwörter.`,
    `Ausgabe:`,
    `SUBJECT: <max 60 Zeichen>`,
    `BODY:\n<Gruß + 3–5 Sätze + genau EIN Link + Sign-off>`
  ].filter(Boolean).join('\n');

  const body = {
    model,
    temperature: 0, // deterministisch
    max_tokens: 350,
    messages: [
      { role: 'system', content: 'Du schreibst knappe, personalisierte B2B-Erstansprachen (Deutsch). Keine Halluzinationen – bleib neutral, wenn Infos fehlen.' },
      { role: 'user', content: prompt }
    ]
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content || '';
  const bodyText = (text.split(/BODY:\s*/i)[1] || text).trim();

  const withLinks = bodyText
    .replace('[WHITEPAPER]', input.whitepaper || '')
    .replace('[CALENDAR]', input.calendar || '');

  return { body: withLinks };
}

export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Secret prüfen
    if (!process.env.WEBHOOK_SECRET || req.query?.secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    // ENVs
    const PD_API          = process.env.PD_API || 'https://api.pipedrive.com/v1';
    const PIPELINE_ID     = Number(process.env.PIPELINE_ID);
    const STAGE_ID        = Number(process.env.STAGE_ID);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402').toLowerCase();
    const F_ENRICH        = process.env.FIELD_ENRICHMENT_SUMMARY;
    const F_INTRO         = process.env.FIELD_EMAIL_INTRO;
    const F_DONE          = process.env.FIELD_AI_ENRICHED;
    const F_SPAM          = process.env.FIELD_SPAM; // optional Yes/No
    const WHITEPAPER_URL  = process.env.WHITEPAPER_URL || '';
    const CALENDAR_URL    = process.env.CALENDAR_URL || '';

    if ((!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      return res.status(500).send('Missing environment variables');
    }

    // Body normalisieren (Webhook v1/v2)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta = body?.meta || {};
    const isV2 = !!body?.data && (meta?.version?.startsWith?.('2') || typeof meta?.entity === 'string');

    const curr: PDDeal = (isV2 ? body?.data : body?.current) || {};
    const previous: any = isV2 ? (body?.previous || {}) : (body?.previous || {});
    const changes = isV2 ? {} : (meta?.changes || {});
    const actionRaw = String(meta?.action || meta?.event_action || '').toLowerCase();
    const objectRaw = String((isV2 ? meta?.entity : (meta?.object || meta?.event_object || meta?.model)) || '').toLowerCase();

    const actionN =
      actionRaw === 'create' ? 'added' :
      actionRaw === 'change' ? 'updated' :
      actionRaw === 'delete' ? 'deleted' : actionRaw;

    const objectN = objectRaw || 'deal';
    if (objectN !== 'deal') return res.status(200).send('ignored');

    // Self-updates (unser eigener PUT) ignorieren, falls als API-Change zurückkommt
    const changeSource = String(meta?.change_source || '');
    if (isV2 && actionN === 'updated' && changeSource === 'api') {
      return res.status(200).send('ignored (self-update)');
    }

    // Stage/Pipeline-Filter (Eintritt in Ziel-Stage)
    const currStageId     = asNumber(curr?.stage_id);
    const prevStageId     = asNumber(previous?.stage_id);
    const currPipelineId  = asNumber(curr?.pipeline_id);
    const pipelineMatch   = currPipelineId === PIPELINE_ID;

    const enteredTargetStage_v1 = actionN === 'updated' && asNumber((changes as any)?.stage_id?.new_value) === STAGE_ID;
    const createdInTargetStage  = actionN === 'added'   && currStageId === STAGE_ID;

    // v2: triggere nur, wenn jetzt in Ziel-Stage und entweder vorher nicht dort ODER kein API-self-update
    const inTargetStage_v2 =
      isV2 &&
      currStageId === STAGE_ID &&
      (actionN === 'added' || (typeof prevStageId === 'number' ? prevStageId !== STAGE_ID : changeSource !== 'api'));

    const stagePass = createdInTargetStage || enteredTargetStage_v1 || inTargetStage_v2;
    if (!stagePass || !pipelineMatch) return res.status(200).send('ignored');

    // Deal laden
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

    // ===== Spam/Company-Ermittlung =====
    let orgName = data.organization_name || data.org_name || '';
    let orgId   = asNumber(data.org_id);

    // Person/E-Mail → Domain
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

    // Spam: Freemail/Disposable
    if (emailDomain && isFreemailOrDisposable(emailDomain)) {
      if (process.env.FIELD_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetch(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [process.env.FIELD_SPAM]: 1 })
        });
      }
      return res.status(200).send('ok (spam/freemail)');
    }
    // Optional streng: MX
    if (emailDomain && !(await hasMX(emailDomain))) {
      if (process.env.FIELD_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetch(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [process.env.FIELD_SPAM]: 1 })
        });
      }
      return res.status(200).send('ok (no_mx)');
    }

    // Falls keine Organisation → aus Domain ableiten, suchen/erstellen, attachen
    if (!orgId && emailDomain) {
      const inferredName = inferOrgNameFromDomain(emailDomain);
      const hits = await pdSearchOrg(PD_API, inferredName);
      const firstHit = Array.isArray(hits) ? hits[0]?.item : null;
      if (firstHit?.id) {
        orgId   = firstHit.id;
        orgName = firstHit.name || inferredName;
      } else {
        const created = await pdCreateOrg(PD_API, inferredName);
        if (created?.id) {
          orgId   = created.id;
          orgName = created.name || inferredName;
        }
      }
      if (orgId) await pdAttachDealToOrg(PD_API, dealId, orgId);
    }

    // ---- Schon angereichert? (Einmal-Flag) ----
    const F_DONE_KEY = process.env.FIELD_AI_ENRICHED;
    const F_DONE_VAL = F_DONE_KEY ? ((data as any)[F_DONE_KEY] ?? data?.custom_fields?.[F_DONE_KEY as any]) : undefined;
    const already = F_DONE_KEY && (F_DONE_VAL === 1 || F_DONE_VAL === '1' || F_DONE_VAL === true || F_DONE_VAL === 'true');
    if (already) return res.status(200).send('already enriched');

    // ===== Website-Signale & LLM =====
    let snippet = '';
    let signals: string[] = [];
    if (emailDomain) {
      const gathered = await gatherCompanySignals(emailDomain);
      snippet = gathered.snippet;
      signals = gathered.signals;
    }

    const personName  = data?.person_name || curr?.person_name || '';
    const productName = 'ISAE 3402'; // kanonisiert

    // LLM Mail erzeugen
    let emailIntro = '';
    try {
      const llm = await generateEmailIntroLLM({
        personName, orgName, product: productName,
        signalList: signals.join(', '), siteSnippet: snippet,
        whitepaper: WHITEPAPER_URL, calendar: CALENDAR_URL
      });
      emailIntro = llm?.body || '';
    } catch {
      emailIntro =
        `Hallo ${personName || 'Team'},\n\n` +
        `wir haben ${orgName || 'Ihr Unternehmen'} kurz angesehen. ` +
        `Bei ${productName} geht es häufig um Audit-Vorbereitung, Kontrollnachweise und effiziente Umsetzung.\n\n` +
        (WHITEPAPER_URL ? `Whitepaper: ${WHITEPAPER_URL}\n` : '') +
        (CALENDAR_URL ? `Kalender: ${CALENDAR_URL}\n` : '') +
        `Welche Zielsetzung verfolgen Sie konkret?\n\nViele Grüße`;
    }

    const enrichmentSummary =
      `Kurzresearch (automatisch):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      (signals.length ? `• Signale: ${signals.join(', ')}\n` : '') +
      (snippet ? `• Auszug: ${snippet.slice(0, 220)}…\n` : '') +
      `• Produkt: ${productName}\n` +
      `• Ansatzpunkte: (TODO)`;

    // ---- Doppel-Update vermeiden: nur schreiben, wenn wirklich neu ----
    const existingIntro   = F_INTRO  ? ((data as any)[F_INTRO]  ?? data?.custom_fields?.[F_INTRO  as any]) : undefined;
    const existingSummary = F_ENRICH ? ((data as any)[F_ENRICH] ?? data?.custom_fields?.[F_ENRICH as any]) : undefined;

    const introChanged   = !existingIntro   || String(existingIntro).trim()   !== String(emailIntro).trim();
    const summaryChanged = !existingSummary || String(existingSummary).trim() !== String(enrichmentSummary).trim();

    if (!introChanged && !summaryChanged) {
      return res.status(200).send('ok (no change)');
    }

    // Update-Body bauen
    const updateBody: Record<string, any> = {};
    if (F_ENRICH && summaryChanged) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO  && introChanged)   updateBody[F_INTRO]  = emailIntro;
    if (F_DONE_KEY)                 updateBody[F_DONE_KEY] = 1;

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
