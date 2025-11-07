// /lib/pd.ts

export function withAuth(url: string) {
  const oauth = process.env.PD_OAUTH_TOKEN;
  if (oauth) return { url, headers: { Authorization: `Bearer ${oauth}` } };
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}api_token=${process.env.PD_API_TOKEN}`, headers: {} as Record<string,string> };
}

export async function pdSearchOrg(pdApi: string, term: string) {
  const cfg = withAuth(`${pdApi}/organizations/search?term=${encodeURIComponent(term)}&exact_match=false`);
  const r = await fetch(cfg.url, { headers: cfg.headers });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data?.items || [];
}

export async function pdCreateOrg(pdApi: string, name: string) {
  const cfg = withAuth(`${pdApi}/organizations`);
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
    body: JSON.stringify({ name })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data || null;
}

export async function pdAttachDealToOrg(pdApi: string, dealId: number, orgId: number) {
  const cfg = withAuth(`${pdApi}/deals/${dealId}`);
  const r = await fetch(cfg.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
    body: JSON.stringify({ org_id: orgId })
  });
  return r.ok;
}
