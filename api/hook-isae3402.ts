// api/hook-isae3402.ts
// Vollversion – robust, idempotent, Node.js Runtime (mit Branchen-Klassifikation, Rollen-Framing, dynamischem Prompt & Anti-Halluzination)
// ENVs (Vercel/Next.js):
// Pflicht: PD_API, PD_API_TOKEN|PD_OAUTH_TOKEN, PIPELINE_ID, STAGE_ID, WEBHOOK_SECRET, OPENAI_API_KEY
// Custom Fields (interne Keys cf_…): FIELD_ENRICHMENT_SUMMARY, FIELD_EMAIL_INTRO, FIELD_AI_ENRICHED, optional FIELD_SPAM
// Optional: PRODUCT_TRIGGER, WHITEPAPER_URL, CALENDAR_URL, WHITEPAPER_LABEL, CALENDAR_LABEL, LLM_MODEL, RICH_TEXT_FIELDS

// -----------------------------------------------------------
// Next.js/Vercel Runtime Hints (wegen dns + AbortController etc.)
// -----------------------------------------------------------
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------
// Kleine Utils
// -----------------------------------------------------------
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

function normalizeTitle(title?: string): string {
  return (title || '').toLowerCase();
}
function roleFrameFromTitle(title?: string): { role: string; frame: string } {
  const t = normalizeTitle(title);
  if (/cto|head of engineering|vp engineering|devops|platform|sre|architect/.test(t))
    return { role: 'Tech', frame: 'Fokus: Changes/Deployments, Zugriffsmodelle (RBAC), Betriebsprozesse/Runbooks, evidenzfähige Kontrollen.' };
  if (/ciso|security|infosec|it(-| )?security|data protection/.test(t))
    return { role: 'Security', frame: 'Fokus: prüfbare Kontrollen, SOC/ISO-Bezug, Risiko-Einordnung, Vendor Due Diligence.' };
  if (/compliance|risk|governance|internal controls|ics/.test(t))
    return { role: 'Compliance', frame: 'Fokus: Kontroll-Design/-Wirksamkeit, Prüfpfade, Nachweisführung in Audits & Assessments.' };
  if (/procurement|einkauf|vendor|supplier|sourcing/.test(t))
    return { role: 'Procurement', frame: 'Fokus: Vendor-Onboarding, Standardnachweise, weniger Rückfragen/Schleifen in Ausschreibungen.' };
  if (/finance|cfo|controller|audit|revision|ban(k|c)/.test(t))
    return { role: 'Finance', frame: 'Fokus: verlässliche Prozessreife, reduzierte Prüfaufwände und klare Kontrollnachweise.' };
  return { role: 'General', frame: 'Fokus: externe Testate für Änderungen, Zugriffe und Betrieb; schnellere Freigaben, weniger Rückfragen.' };
}

function isNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function asNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
function domainFromEmail(email?: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase();
}
function inferOrgNameFromDomain(domain: string): string {
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const core = clean
    .replace(/^www\./, '')
    .replace(/^mail\./, '')
    .split('.')
    .slice(0, -1)
    .join('-')
    .replace(/-/g, ' ')
    .trim();
  return core
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ') || clean;
}
const FREEMAIL = new Set([
  'gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com','live.com','icloud.com',
  'gmx.de','web.de','t-online.de','freenet.de','mail.de','proton.me','protonmail.com',
  'hey.com','aol.com','yandex.com','yandex.ru'
]);
const DISPOSABLE = new Set(['mailinator.com','10minutemail.com','tempmail.com','guerrillamail.com','trashmail.com']);
function isFreemailOrDisposable(domain?: string | null): boolean {
  if (!domain) return true;
  return FREEMAIL.has(domain) || DISPOSABLE.has(domain);
}
// In Serverless-Umgebungen kann MX blockiert sein → lieber „true“ im Fehlerfall (keine False Positives)
async function hasMX(domain: string): Promise<boolean> {
  try {
    // @ts-ignore
    const dns = require('dns').promises;
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch { return true; }
}

// -----------------------------------------------------------
// HTTP Helpers (Timeout + 1 Retry mit Backoff)
// -----------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally { clearTimeout(t); }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url: string, init: RequestInit = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retry = 1 } = {}) {
  let lastErr: any;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : {};
    } catch (e) {
      lastErr = e;
      if (attempt < retry) await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------
// Pipedrive-Helpers
// -----------------------------------------------------------
function withAuth(url: string) {
  const oauth = process.env.PD_OAUTH_TOKEN;
  if (oauth) return { url, headers: { Authorization: `Bearer ${oauth}` } } as const;
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}api_token=${process.env.PD_API_TOKEN}`, headers: {} as Record<string, string> } as const;
}
async function pdSearchOrg(pdApi: string, term: string) {
  const cfg = withAuth(`${pdApi}/organizations/search?term=${encodeURIComponent(term)}&exact_match=false`);
  try {
    const j = await fetchJson(cfg.url, { headers: cfg.headers });
    return j?.data?.items || [];
  } catch { return []; }
}
async function pdCreateOrg(pdApi: string, name: string) {
  const cfg = withAuth(`${pdApi}/organizations`);
  try {
    const j = await fetchJson(
      cfg.url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) }, body: JSON.stringify({ name }) },
    );
    return j?.data || null;
  } catch { return null; }
}
async function pdAttachDealToOrg(pdApi: string, dealId: number, orgId: number) {
  const cfg = withAuth(`${pdApi}/deals/${dealId}`);
  try {
    const r = await fetchWithTimeout(
      cfg.url,
      { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) }, body: JSON.stringify({ org_id: orgId }) },
    );
    return r.ok;
  } catch { return false; }
}

// Name-Normalisierung für bessere Orga-Matches
function normalizeName(x: string): string {
  return (x || '')
    .toLowerCase()
    .replace(/\b(gmbh|ag|kg|mbh|ug|co\.?|&|und|inc|llc|ltd|sarl|s\.a\.)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// -----------------------------------------------------------
// Website-Signals (einfach & schnell)
// -----------------------------------------------------------
async function fetchText(url: string) {
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' as any });
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

// --- HTML-Helpers -------------------------------------------------
function extractMeta(html: string, nameOrProp: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]*?content=["']([^"']+)["'][^>]*>`, 'i');
  const m = html.match(re);
  return m?.[1]?.trim() || '';
}
function extractJSONLD(html: string): any[] {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const out: any[] = [];
  for (const b of blocks) {
    try {
      const json = JSON.parse(b[1]);
      if (Array.isArray(json)) out.push(...json);
      else out.push(json);
    } catch { /* ignore */ }
  }
  return out;
}

// --- Erweiterte Enrichment-Funktion -------------------------------
async function enrichCompanyProfile(domain: string) {
  const base0 = domain.startsWith('http') ? domain : `https://${domain}`;
  const bases = [base0.replace(/\/$/, ''), base0.replace(/\/$/, '').replace(/^https:\/\//,'https://www.')];
  const paths = [
    '', '/about', '/en/about', '/company', '/impressum', '/imprint',
    '/security', '/trust', '/compliance', '/legal', '/privacy', '/gdpr',
    '/products', '/platform', '/solutions', '/soc', '/audit'
  ];

  let bestHtml = '';
  for (const b of bases) {
    const parts = await Promise.all(paths.map(p => fetchWithTimeout(b + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.ok ? r.text() : '').catch(()=>'') ));
    const joined = parts.filter(Boolean).join('\n');
    if (joined.length > bestHtml.length) bestHtml = joined;
  }
  const text = bestHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Meta / OG
  const ogTitle = extractMeta(bestHtml, 'og:title') || extractMeta(bestHtml, 'twitter:title');
  const ogDesc  = extractMeta(bestHtml, 'og:description') || extractMeta(bestHtml, 'twitter:description') || extractMeta(bestHtml, 'description');

  // JSON-LD
  const jsonld  = extractJSONLD(bestHtml);
  const orgNode = jsonld.find(n => (n['@type'] === 'Organization' || (Array.isArray(n['@type']) && n['@type'].includes('Organization')))) || {};
  const swApp   = jsonld.find(n => (n['@type'] === 'SoftwareApplication')) || {};
  const nameLD  = orgNode?.name || swApp?.name || '';
  const descLD  = orgNode?.description || swApp?.description || '';

  // Keyword-Heuristiken
  const lower = text.toLowerCase();
  const has = (k: string | RegExp) => (typeof k === 'string' ? lower.includes(k) : k.test(lower));
  const kw = new Set<string>();
  [
    'saas','api','multi-tenant','marketplace','merchant','feed','product data','shopify','magento','bigcommerce',
    'e-commerce','checkout','psp','pricing','repricing','catalog','integration','etl','mdm','pim','gdpr','iso 27001','soc 2'
  ].forEach(k => { if (has(k)) kw.add(k); });

  // kompakte Company-Highlights (max 300–400 Zeichen)
  const highlights = [
    ogTitle, nameLD
  ].filter(Boolean).slice(0,1).join(' | ');
  const blurb = [ ogDesc, descLD ].filter(Boolean).join(' ').slice(0, 320);

  return {
    highlights,         // z.B. "Channel Pilot Solutions – Product Data Platform"
    blurb,              // Kurzbeschreibung aus Meta/LD
    keywords: Array.from(kw), // ['saas','marketplace','api',...]
    rawText: text.slice(0, 1200) // für dein existing siteSnippet
  };
}

async function gatherCompanySignals(domain: string) {
  const raw = domain.startsWith('http') ? domain : `https://${domain}`;
  const baseCandidates = [raw.replace(/\/$/, ''), raw.replace(/\/$/, '').replace(/^https:\/\//, 'https://www.')];
  const paths = [
  '', '/about', '/en/about', '/company', '/imprint', '/impressum',
  '/security', '/trust', '/compliance', '/legal', '/gdpr', '/privacy',
  '/soc', '/audit'
  ];

  let joined = '';
  for (const base of baseCandidates) {
    const texts = await Promise.all(paths.map((p) => fetchText(base + p)));
    const chunk = texts.filter(Boolean).join(' \n');
    if (chunk.length > joined.length) joined = chunk; // nimm die längste/erfolgreichste Variante
  }
  joined = joined.slice(0, 8000);

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

// -----------------------------------------------------------
// Branchen-Klassifikation & dynamisches Framing
// -----------------------------------------------------------
function classifyIndustry(
  orgName?: string,
  snippet?: string,
  signals: string[] = []
): { tag: string; frame: string } {
  const text = `${orgName || ''} ${snippet || ''}`.toLowerCase();
  const has = (arr: (string | RegExp)[]) =>
    arr.some((k) => (typeof k === 'string' ? text.includes(k.toLowerCase()) : (k as RegExp).test(text)));

  const rules: Array<{ tag: string; keys: (string | RegExp)[]; frame: string }> = [
    { tag: 'M&A', keys: ['m&a','mergers','acquisitions','deal advisory','corporate finance','due diligence','buy-side','sell-side'],
      frame: 'Fokus auf Due-Diligence-Phasen: extern testierte Kontrollen beschleunigen Q&A, reduzieren Rückfragen und machen operative Risiken bewertbar.' },
    { tag: 'SaaS', keys: ['saas','subscription','api','plattform','cloud','multi-tenant'],
      frame: 'In SaaS-/Cloud-Umgebungen werden prüfbare Kontrollen zu Changes, Zugriffsrechten und Betrieb häufig in Ausschreibungen gefordert.' },
    { tag: 'E-Commerce', keys: ['e-commerce','shop','marketplace','merchant','checkout','cart'],
      frame: 'Bei Händler-/Plattform-Integrationen erleichtern testierte Kontrollen das Vendor-Onboarding und verringern Rückfragen zu Datenschnittstellen.' },
    { tag: 'FinTech', keys: ['fintech','payment','psd2','core banking','banking','kredit'],
      frame: 'In regulierten Umfeldern zählen nachweisbare Kontrollen für Partnerbanken und Prüfer – extern testiert spart Abstimmungsaufwand.' },
    { tag: 'Healthcare', keys: ['gesundheit','health','clinic','patient','medizin','hipaa'],
      frame: 'Bei sensiblen Gesundheitsdaten unterstützen testierte Prozesse die Risikoeinstufung und Zusammenarbeit mit Trägern/Kassen.' },
    { tag: 'Public Sector', keys: ['öffentlicher dienst','kommune','ministerium','behörde','vergabe','vergaberecht'],
      frame: 'Im öffentlichen Sektor sind formale Nachweise und Vergabeanforderungen zentral – testierte Kontrollen beschleunigen Verfahren.' },
    { tag: 'Logistics', keys: ['logistik','transport','fulfillment','warehouse','lieferkette'],
      frame: 'Bei Prozessketten schaffen prüfbare Betriebs-/Änderungsprozesse Transparenz und verringern Übergaberisiken.' },
  ];

  for (const rule of rules) { if (has(rule.keys)) return { tag: rule.tag, frame: rule.frame }; }

  // einfache Fallbacks über Signals
  if (signals.some((s) => /finance|finanz/i.test(s))) {
    return { tag: 'Finance', frame: 'Für Finanzpartner und Prüfer sind testierte Kontrollen ein etablierter Nachweis – das reduziert Rückfragen in Prüfungen.' };
  }
  return { tag: 'Generic', frame: 'Externe Testate zu Änderungen, Zugriffsrechten und Betriebsprozessen reduzieren Nachweishürden und beschleunigen Freigaben.' };
}

function buildIndustryFrame(orgName?: string, snippet?: string, signals: string[] = []): string {
  const { tag, frame } = classifyIndustry(orgName, snippet, signals);
  return `Branchen-Frame (${tag}): ${frame}`;
}

// -----------------------------------------------------------
// Link-Labels & Builder (HTML-Anker + Plain-Text)
// -----------------------------------------------------------
const WP_LABEL_DEFAULT = 'Whitepaper ISAE 3402';
const CAL_LABEL_DEFAULT = '20-Min-Termin buchen';
function buildLinks(opts: { whitepaper?: string; calendar?: string; wpLabel?: string; calLabel?: string }) {
  const wpUrl = opts.whitepaper || '';
  const calUrl = opts.calendar || '';
  const wpLabel = opts.wpLabel || WP_LABEL_DEFAULT;
  const calLabel = opts.calLabel || CAL_LABEL_DEFAULT;
  const wpHtml = wpUrl ? `<a href="${wpUrl}" target="_blank" rel="noopener noreferrer">${wpLabel}</a>` : '';
  const calHtml = calUrl ? `<a href="${calUrl}" target="_blank" rel="noopener noreferrer">${calLabel}</a>` : '';
  const wpText = wpUrl ? `${wpLabel}: ${wpUrl}` : '';
  const calText = calUrl ? `${calLabel}: ${calUrl}` : '';
  return { wpHtml, calHtml, wpText, calText };
}

// -----------------------------------------------------------
// Post-Processing Guards (Anti-Halluzination & Länge)
// -----------------------------------------------------------
function hardGuards(body: string) {
  // Verhindere Fantasie-Zusätze bei ISAE 3402
  body = body.replace(/\bisae\s*3402\b\s*(lead|pack|suite|iap|plus|pro)?/gi, 'ISAE 3402');
  // eckige Klammern entfernen
  body = body.replace(/\[([^\]]+)\]/g, '$1');
  // grobes Längenlimit
  const words = body.split(/\s+/);
  if (words.length > 110) body = words.slice(0, 110).join(' ');
  return body.trim();
}

// -----------------------------------------------------------
// LLM: personalisierte Mail (Tokens WHITEPAPER_LINK / KALENDER_LINK)
// -----------------------------------------------------------
async function generateEmailIntroLLM(input: {
  personName?: string; orgName?: string; product: string;
  signalList?: string; siteSnippet?: string;
  whitepaper?: string; calendar?: string;
  companyHighlights?: string; roleFrame?: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const signals = (input.signalList || '').split(',').map(s => s.trim()).filter(Boolean);
  const industryFrame = buildIndustryFrame(input.orgName, input.siteSnippet, signals);

  const prompt = [
    'Schreibe eine kurze, präzise B2B-Erstansprache auf Deutsch.',
    '70–95 Wörter. 3–5 Sätze. Kein Betreff. Kein Gruß. Keine Emojis. Keine Bulletpoints.',
    'Ton: sachlich, respektvoll, lösungsorientiert. Keine Superlative. Kein Marketing-Sprech.',

    `Adressat (optional): ${input.personName || 'Team'}`,
    `Unternehmen: ${input.orgName || 'Unbekannt'}`,
    signals.length ? `Signale (nur verwenden, wenn passend): ${signals.join(', ')}` : '',
    input.siteSnippet ? `Auszug/Website (nur vorsichtig paraphrasieren): ${input.siteSnippet}` : '',
    input.companyHighlights ? `Company-Highlights: ${input.companyHighlights}` : '',
    industryFrame,
    input.roleFrame ? `Rollen-Frame: ${input.roleFrame}` : '',

    `Aufgabe: Erkläre knapp, WARUM ${input.orgName || 'das Unternehmen'} ${input.product} benötigt – mit Bezug auf typische Nachweise/Anforderungen in dieser Branche und (falls sinnvoll) die Rolle der Ansprechperson.`,

    'Struktur:',
    '1) Einstieg mit kurzem, plausiblen Anwendungskontext (aus Signals/Website; wenn unklar, neutral).',
    `2) Konkreter Nutzen von ${input.product} (z. B. weniger Rückfragen in Assessments, prüfbare Kontrollen, schnelleres Onboarding).`,
    '3) Beispiel-Kontext – z. B. Änderungen an Systemen, Zugriffe auf Daten, Betriebs-/Übergabeprozesse.',
    '4) Abschluss: zwei knappe Sätze; dann zwei separate Call-to-Action-Zeilen (siehe unten).',

    // Harte Verbote
    'Es dürfen KEINE neuen Produkt-/Zertifikatsbezeichnungen erfunden werden.',
    'Der einzige zulässige Produktname ist exakt: "ISAE 3402". Keine Zusätze wie "Lead", "Pack", "Suite", "iAP" etc.',
    'Wenn unklar: neutral formulieren ("ISAE 3402 Bericht" / "ISAE 3402 Nachweis").',
    'Verbote: keine Floskeln wie „branchenführend“, „maßgeschneidert“, „innovativ“.',
    'Keine Behauptungen ohne Basis; im Zweifel: „häufig gefordert“, „typisch in Ausschreibungen“.',

    'Am Ende des Textes GENAU diese zwei Zeilen, jeweils alleinstehend:',
    'Weitere Details im Whitepaper: WHITEPAPER_LINK.',
    'Wenn Sie das Thema kurz einordnen möchten: KALENDER_LINK.'
  ].filter(Boolean).join('\n');

  const body = {
    model,
    temperature: 0,
    max_tokens: 350,
    messages: [
      { role: 'system', content: 'Du schreibst knappe, personalisierte B2B-Erstansprachen (Deutsch). Keine Halluzinationen – erfinde KEINE Produkt- oder Zertifikatsnamen. Verwende exakt den Begriff „ISAE 3402“; keine Zusätze.' },
      { role: 'user', content: prompt },
    ],
  } as const;

  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, 20000);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI: empty completion');
  return { body: text };
}

// -----------------------------------------------------------
// Handler
// -----------------------------------------------------------
export default async function handler(req: any, res: any) {
  try {
    if (process.env.KILL_SWITCH === '1') return res.status(200).send('noop (kill switch)');
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    // Secret an URL prüfen (keine Basic Auth nötig hier)
    if (!process.env.WEBHOOK_SECRET || req.query?.secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    // ENVs
    const PD_API = process.env.PD_API || 'https://api.pipedrive.com/v1';
    const PIPELINE_ID = Number(process.env.PIPELINE_ID);
    const STAGE_ID = Number(process.env.STAGE_ID);
    const PRODUCT_TRIGGER = (process.env.PRODUCT_TRIGGER || 'ISAE 3402');

    const F_ENRICH = process.env.FIELD_ENRICHMENT_SUMMARY as string | undefined;
    const F_INTRO = process.env.FIELD_EMAIL_INTRO as string | undefined;
    const F_DONE = process.env.FIELD_AI_ENRICHED as string | undefined;
    const F_SPAM = process.env.FIELD_SPAM as string | undefined;

    const WHITEPAPER_URL = process.env.WHITEPAPER_URL || '';
    const CALENDAR_URL = process.env.CALENDAR_URL || '';
    const WHITEPAPER_LABEL = process.env.WHITEPAPER_LABEL || WP_LABEL_DEFAULT;
    const CALENDAR_LABEL = process.env.CALENDAR_LABEL || CAL_LABEL_DEFAULT;

    const RICH_TEXT_FIELDS = process.env.RICH_TEXT_FIELDS !== '0'; // default: HTML erlaubt

    if ((!process.env.PD_API_TOKEN && !process.env.PD_OAUTH_TOKEN) || !PIPELINE_ID || !STAGE_ID) {
      return res.status(500).send('Missing environment variables');
    }

    // Body normalisieren (v1/v2)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const meta = body?.meta || {};
    const isV2 = !!body?.data && (meta?.version?.startsWith?.('2') || typeof meta?.entity === 'string');

    const curr: PDDeal = (isV2 ? body?.data : body?.current) || {};
    const previous: any = body?.previous || {};
    const changes = isV2 ? {} : (meta?.changes || {});
    const actionRaw = String(meta?.action || meta?.event_action || '').toLowerCase();
    const objectRaw = String((isV2 ? meta?.entity : (meta?.object || meta?.event_object || meta?.model)) || '').toLowerCase();

    const actionN =
      actionRaw === 'create' ? 'added' :
      actionRaw === 'change' ? 'updated' :
      actionRaw === 'delete' ? 'deleted' : actionRaw;
    const objectN = objectRaw || 'deal';
    if (objectN !== 'deal') return res.status(200).send('ignored');

    // Self-update-Guard (unser eigener PUT kommt als updated+api zurück)
    const changeSource = String(meta?.change_source || '');
    if (isV2 && actionN === 'updated' && changeSource === 'api') {
      return res.status(200).send('ignored (self-update)');
    }

    // Stage/Pipeline-Filter – nur Eintritt/Neuanlage in Ziel-Stage
    const currStageId = asNumber(curr?.stage_id);
    const prevStageId = asNumber(previous?.stage_id);
    const currPipelineId = asNumber(curr?.pipeline_id);
    const pipelineMatch = currPipelineId === PIPELINE_ID;

    const enteredTargetStage_v1 = actionN === 'updated' && asNumber((changes as any)?.stage_id?.new_value) === STAGE_ID;
    const createdInTargetStage = actionN === 'added' && currStageId === STAGE_ID;
    const inTargetStage_v2 =
      isV2 && currStageId === STAGE_ID &&
      (actionN === 'added' || (typeof prevStageId === 'number' ? prevStageId !== STAGE_ID : changeSource !== 'api'));

    const stagePass = createdInTargetStage || enteredTargetStage_v1 || inTargetStage_v2;
    if (!stagePass || !pipelineMatch) return res.status(200).send('ignored');

    // Deal-ID & Deal laden
    const dealId = asNumber((isV2 ? meta?.entity_id : meta?.id) || curr?.id);
    if (!dealId) return res.status(200).send('ignored');

    const getCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const getJson = await fetchJson(getCfg.url, { headers: getCfg.headers }, { retry: 1 });
    const data: PDDeal = (getJson?.data) || {};

    // Titel-/Produkt-Trigger (optional)
    const title = String(data?.title || curr?.title || '').toLowerCase();
    if (PRODUCT_TRIGGER && !title.includes(PRODUCT_TRIGGER.toLowerCase())) {
      return res.status(200).send('ignored');
    }

    // ===== Spam/Company-Ermittlung & sichere Org-Zuordnung (Standardfeld) =====

    // 1) Vorhandene Organisation respektieren
    let orgName = data.organization_name || data.org_name || '';
    let orgId = asNumber(
      data.org_id ??
      (typeof data.organization_id === 'object' ? (data.organization_id as any)?.value : data.organization_id)
    );

    // 2) Person/E-Mail → Domain (für Spam-Check & Fallback)
    let emailDomain: string | null = null;
    let personTitle = '';
    if (data.person_id) {
      const pid = typeof data.person_id === 'object' ? (data.person_id as any).value || 0 : Number(data.person_id);
      if (pid) {
        const cfgP = withAuth(`${PD_API}/persons/${pid}`);
        const pJson = await fetchJson(cfgP.url, { headers: cfgP.headers }).catch(() => null as any);
        if (pJson?.data) {
          const p = pJson.data || {};
          const primaryEmail = Array.isArray(p.email) ? p.email[0]?.value : p.email;
          emailDomain = domainFromEmail(primaryEmail);
          if (!orgName && p.org_name) orgName = p.org_name;
          if (!orgId && p.org_id) {
            const pidOrgId = asNumber(p.org_id);
            if (pidOrgId) orgId = pidOrgId;
          }
          personTitle = p.title || p.label || '';
        }
      }
    }

    // 3) Spam-Filter
    if (emailDomain && isFreemailOrDisposable(emailDomain)) {
      if (F_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetchWithTimeout(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [F_SPAM]: 1 }),
        }).catch(() => null);
      }
      return res.status(200).send('ok (spam/freemail)');
    }
    if (emailDomain && !(await hasMX(emailDomain))) {
      if (F_SPAM) {
        const putSpam = withAuth(`${PD_API}/deals/${dealId}`);
        await fetchWithTimeout(putSpam.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(putSpam.headers || {}) },
          body: JSON.stringify({ [F_SPAM]: 1 }),
        }).catch(() => null);
      }
      return res.status(200).send('ok (no_mx)');
    }

    // 4) Wenn bereits eine Organisation am Deal hängt → NICHT ändern
    const hasExistingOrg = !!orgId;
    if (!hasExistingOrg) {
      // 4a) Zuerst: Firmenname aus dem Standardfeld des Webforms
      const formOrgName = String(
        curr?.organization_name || curr?.org_name ||
        data?.organization_name || data?.org_name || ''
      ).trim();

      if (formOrgName) {
        const hitsByName = await pdSearchOrg(PD_API, formOrgName);
        const normForm = normalizeName(formOrgName);
        const hit = Array.isArray(hitsByName) ? hitsByName.find((h: any) => {
          const candidate = normalizeName(h?.item?.name || '');
          return candidate === normForm;
        })?.item : undefined;

        if (hit?.id) {
          orgId = hit.id;
          orgName = hit.name || formOrgName;
          if (isNum(orgId)) { await pdAttachDealToOrg(PD_API, dealId, orgId); }
          console.log('attached deal to existing org by form name', { dealId, orgId, orgName });
        } else {
          const created = await pdCreateOrg(PD_API, formOrgName);
          if (created?.id) {
            orgId = created.id;
            orgName = created.name || formOrgName;
            if (isNum(orgId)) { await pdAttachDealToOrg(PD_API, dealId, orgId); }
            console.log('created org from form name and attached', { dealId, orgId, orgName });
          }
        }
      }

      // 4b) Falls kein Formularname → Domain-Fallback
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
        if (isNum(orgId)) {
          await pdAttachDealToOrg(PD_API, dealId, orgId);
          console.log('attached deal to org by inferred domain', { dealId, orgId, orgName });
        }
      }
    }

    // -----------------------------------------------------------
    // Einmal-Flag / Idempotenz
    // -----------------------------------------------------------
    const F_DONE_VAL = F_DONE ? ((data as any)[F_DONE] ?? data?.custom_fields?.[F_DONE as any]) : undefined;
    const already = F_DONE && (F_DONE_VAL === 1 || F_DONE_VAL === '1' || F_DONE_VAL === true || F_DONE_VAL === 'true');
    if (already) return res.status(200).send('already enriched');

    // -----------------------------------------------------------
    // Website-Signals sammeln & LLM generieren
    // -----------------------------------------------------------
    let snippet = '';
    let signals: string[] = [];
    let company: any = {};
    if (emailDomain) {
      const gathered = await gatherCompanySignals(emailDomain);
      snippet = gathered.snippet;
      signals = gathered.signals;

      company = await enrichCompanyProfile(emailDomain);
      if (company?.rawText && company.rawText.length > snippet.length) {
        snippet = company.rawText; // nimm das bessere Material
      }
    }

    const personName = data?.person_name || curr?.person_name || '';
    const productName = PRODUCT_TRIGGER || 'ISAE 3402';
    const { role, frame: roleFrame } = roleFrameFromTitle(personTitle);
    const companyHighlights = [
      company?.highlights,
      company?.blurb
    ].filter(Boolean).join(' – ').slice(0, 400);

    let emailIntro: string;
    try {
      const llm = await generateEmailIntroLLM({
        personName, orgName, product: productName,
        signalList: signals.join(', '), siteSnippet: snippet,
        whitepaper: WHITEPAPER_URL, calendar: CALENDAR_URL,
        companyHighlights,
        roleFrame
      });
      emailIntro = (llm?.body || '').trim();
    } catch (e: any) {
      console.warn('LLM failed, using fallback text:', e?.message);
      emailIntro = `Wir sehen bei ähnlichen Unternehmen häufig Bedarf an ${productName} – insbesondere rund um klar definierte Kontrollen und Prüfpfade. Gern teilen wir Details und Beispiele. WHITEPAPER_LINK Alternativ direkt sprechen: KALENDER_LINK.`;
    }

    // Anti-Halluzination & Längenbegrenzung
    emailIntro = hardGuards(emailIntro);

    // Tokens ersetzen & Format (HTML vs. Plain-Text)
    const { wpHtml, calHtml, wpText, calText } = buildLinks({
      whitepaper: WHITEPAPER_URL,
      calendar: CALENDAR_URL,
      wpLabel: WHITEPAPER_LABEL,
      calLabel: CALENDAR_LABEL,
    });

    if (RICH_TEXT_FIELDS) {
      if (wpHtml) {
        emailIntro = emailIntro.includes('WHITEPAPER_LINK')
          ? emailIntro.replace(/WHITEPAPER_LINK/g, wpHtml)
          : emailIntro + (emailIntro.endsWith('.') ? '' : '.') + ` Weitere Details im ${WHITEPAPER_LABEL}: ${wpHtml}.`;
      }
      if (calHtml) {
        emailIntro = emailIntro.includes('KALENDER_LINK')
          ? emailIntro.replace(/KALENDER_LINK/g, calHtml)
          : emailIntro + ` Alternativ direkt sprechen: ${calHtml}.`;
      }
    } else {
      // Plain-Text-Felder: keine HTML-Anker
      if (wpText) {
        emailIntro = emailIntro.includes('WHITEPAPER_LINK')
          ? emailIntro.replace(/WHITEPAPER_LINK/g, wpText)
          : emailIntro + (emailIntro.endsWith('.') ? '' : '.') + ` Weitere Details im ${wpText}.`;
      }
      if (calText) {
        emailIntro = emailIntro.includes('KALENDER_LINK')
          ? emailIntro.replace(/KALENDER_LINK/g, calText)
          : emailIntro + ` Alternativ direkt sprechen: ${calText}.`;
      }
    }

    // Begrüßung + Sign-off ergänzen, falls nicht vorhanden (Template rendert HTML oder Plain-Text)
    if (!/^hallo/i.test(emailIntro)) {
      const greeting = `Hallo ${personName || 'Team'},\n\n`;
      const signoff = `\n\nViele Grüße`;
      emailIntro = greeting + emailIntro + signoff;
    }

    const enrichmentSummary =
      `Kurzresearch (automatisch):\n` +
      `• Person: ${personName || 'n/a'}\n` +
      `• Unternehmen: ${orgName || 'n/a'}\n` +
      (signals.length ? `• Signale: ${signals.join(', ')}\n` : '') +
      (snippet ? `• Auszug: ${snippet.slice(0, 220)}…\n` : '') +
      `• Produkt: ${productName}\n` +
      `• Rolle: ${role}\n` +
      `• Ansatzpunkte: (TODO)`;

    // Nur schreiben, wenn wirklich neu
    const existingIntro = F_INTRO ? ((data as any)[F_INTRO] ?? data?.custom_fields?.[F_INTRO as any]) : undefined;
    const existingSummary = F_ENRICH ? ((data as any)[F_ENRICH] ?? data?.custom_fields?.[F_ENRICH as any]) : undefined;
    const introChanged = !existingIntro || String(existingIntro).trim() !== String(emailIntro).trim();
    const summaryChanged = !existingSummary || String(existingSummary).trim() !== String(enrichmentSummary).trim();
    if (!introChanged && !summaryChanged) return res.status(200).send('ok (no change)');

    // Update senden (optimistisch). Optional: zweiter GET + Vergleich für maximale Idempotenz.
    const updateBody: Record<string, any> = {};
    if (F_ENRICH && summaryChanged) updateBody[F_ENRICH] = enrichmentSummary;
    if (F_INTRO && introChanged) updateBody[F_INTRO] = emailIntro;
    if (F_DONE) updateBody[F_DONE] = 1;

    if (Object.keys(updateBody).length === 0) return res.status(200).send('ok (no fields configured)');

    const putCfg = withAuth(`${PD_API}/deals/${dealId}`);
    const upd = await fetchWithTimeout(putCfg.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(putCfg.headers || {}) },
      body: JSON.stringify(updateBody),
    });
    const updText = await upd.text();
    if (!upd.ok) return res.status(502).send(`Pipedrive update failed ${upd.status} ${updText.slice(0, 120)}`);

    return res.status(200).send('ok');
  } catch (e: any) {
    console.error('Unhandled error:', e);
    return res.status(500).send(e?.message || 'error');
  }
}
