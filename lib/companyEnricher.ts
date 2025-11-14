// lib/companyEnricher.ts
import { env } from "./env";

export type CompanyIntro = {
  companyName: string;
  industry?: string;
  oneLiner: string;
  topics: string[];
  website?: string | null;
};

type BuildCompanyIntroParams = {
  email: string;
  orgNameRaw: string | null;
};

console.log("[ENRICH] companyEnricher module loaded");

// Hilfsfunktion: Domain aus E-Mail ziehen
function extractDomainFromEmail(email: string): string | null {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return null;
  const domain = email.slice(atIndex + 1).trim().toLowerCase();
  // Freemail-Domains ignorieren
  const freemail = [
    "gmail.com",
    "gmx.de",
    "web.de",
    "outlook.com",
    "hotmail.com",
    "icloud.com",
    "yahoo.com",
    "t-online.de",
  ];
  if (freemail.includes(domain)) return null;
  return domain;
}

// Domain grob in Firmennamen umwandeln: timetac.com -> Timetac
function domainToName(domain: string): string {
  const withoutSub = domain.replace(/^www\./, "");
  const main = withoutSub.split(".")[0];
  if (!main) return domain;
  return main.charAt(0).toUpperCase() + main.slice(1);
}

// Brave Web Search Wrapper
async function braveSearchWeb(query: string): Promise<any[]> {
  if (!env.brave.apiKey) {
    console.warn("[BRAVE] No BRAVE_API_KEY set, skipping Brave search.");
    return [];
  }


  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");

  console.log("[BRAVE] Calling Brave Search", url.toString());

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Subscription-Token": env.brave.apiKey,
      Accept: "application/json",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("[BRAVE] API error", res.status, text);
    return [];
  }

  try {
    const json = JSON.parse(text);
    const webResults = json.web?.results ?? [];
    console.log("[BRAVE] Got results", webResults.length);
    return webResults;
  } catch (e) {
    console.error("[BRAVE] Failed to parse JSON", e, text);
    return [];
  }
}

export async function buildCompanyIntro(
  params: BuildCompanyIntroParams
): Promise<CompanyIntro> {
  const { email, orgNameRaw } = params;

  const emailDomain = extractDomainFromEmail(email);
  const baseName =
    orgNameRaw?.trim() ||
    (emailDomain ? domainToName(emailDomain) : "dein Unternehmen");

  console.log("[ENRICH] Building company intro for", {
    email,
    orgNameRaw,
    emailDomain,
    baseName,
  });

  // Wenn wir keine Domain haben und keinen Namen -> direkt Fallback
  if (!emailDomain && !orgNameRaw) {
    console.log("[ENRICH] No domain and no orgName, using simple fallback.");
    return {
      companyName: baseName,
      oneLiner: "ein Unternehmen in deinem Bereich",
      topics: [],
    };
  }

  // Brave-Queries bauen
  const queries: string[] = [];

  if (orgNameRaw) {
    queries.push(`${orgNameRaw} company overview`);
    queries.push(`${orgNameRaw} what does this company do`);
    queries.push(`${orgNameRaw} industry`);
  }

  if (emailDomain) {
    queries.push(`${emailDomain} company`);
    queries.push(`site:${emailDomain} about`);
  }

  const uniqueQueries = Array.from(new Set(queries));

  let bestSnippet: string | null = null;
  let website: string | null = null;

  const topics = new Set<string>();
  let industry: string | undefined;

  for (const q of uniqueQueries) {
    const results = await braveSearchWeb(q);
    for (const r of results) {
      if (!bestSnippet && r.description) {
        bestSnippet = r.description;
      }
      if (!website && r.url) {
        website = r.url;
      }

      const title = (r.title ?? "") as string;
      const desc = (r.description ?? "") as string;
      const combined = `${title}. ${desc}`.toLowerCase();

      if (combined.includes("saas")) topics.add("SaaS");
      if (combined.includes("software")) topics.add("Software");
      if (combined.includes("hr")) topics.add("HR");
      if (
        combined.includes("time tracking") ||
        combined.includes("zeiterfassung")
      )
        topics.add("Zeiterfassung");
      if (
        combined.includes("finance") ||
        combined.includes("accounting") ||
        combined.includes("financial")
      )
        topics.add("Finanzen");
      if (
        combined.includes("security") ||
        combined.includes("infosec") ||
        combined.includes("information security")
      )
        topics.add("Security");

      if (!industry) {
        if (combined.includes("human resources") || combined.includes("hr")) {
          industry = "HR / People Operations";
        } else if (
          combined.includes("time tracking") ||
          combined.includes("zeiterfassung")
        ) {
          industry = "Zeiterfassung / Workforce Management";
        } else if (combined.includes("saas") || combined.includes("cloud")) {
          industry = "Cloud / SaaS";
        }
      }
    }
  }

  if (!bestSnippet) {
    console.log("[ENRICH] No meaningful Brave result, using fallback.");
    return {
      companyName: baseName,
      oneLiner: "ein Unternehmen in deinem Bereich",
      topics: [],
      industry,
      website,
    };
  }

  let oneLiner = bestSnippet.trim();
  if (oneLiner.length > 220) {
    oneLiner = oneLiner.slice(0, 217) + "...";
  }

  const topicsArr = Array.from(topics);

  const intro: CompanyIntro = {
    companyName: baseName,
    oneLiner,
    topics: topicsArr,
    industry,
    website,
  };

  console.log("[ENRICH] Final CompanyIntro", intro);
  return intro;
}
