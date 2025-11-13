// lib/braveSearch.ts
import { env } from "./env";

export type BraveSnippet = {
  title: string;
  url: string;
  description?: string;
  pageAge?: string;
  pageFetched?: string;
};

export async function searchCompanyWebContext(params: {
  companyName?: string | null;
  domain?: string | null;
}): Promise<BraveSnippet[]> {
  const qParts: string[] = [];

  if (params.companyName) qParts.push(`"${params.companyName}"`);
  if (params.domain) qParts.push(`site:${params.domain}`);

  // Fokus auf Unternehmensinfos & Inhalte
  qParts.push('(blog OR news OR "Presse" OR "Über uns" OR "Case Study")');

  const query = qParts.join(" ");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  url.searchParams.set("country", "de");
  url.searchParams.set("safesearch", "moderate");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": env.brave.apiKey,
    },
  });

  if (!res.ok) {
    console.error("Brave API error", res.status, await res.text());
    return [];
  }

  const json = await res.json();
  const web = json.web as { results?: any[] } | undefined;
  if (!web?.results?.length) return [];

  return web.results.slice(0, 5).map((r: any) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    pageAge: r.page_age,
    pageFetched: r.page_fetched,
  }));
}
