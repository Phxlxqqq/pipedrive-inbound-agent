// lib/companyEnricher.ts
import {
  getDomainFromEmail,
  isFreemail,
  companyNameFromDomain,
} from "./leadHelpers";
import { searchCompanyWebContext } from "./braveSearch";
import { openai } from "./openaiClient";

export type CompanyIntro = {
  companyName: string;
  industry?: string;
  oneLiner: string;
  topics: string[];
};

export async function buildCompanyIntro(params: {
  email: string;
  orgNameRaw?: string | null;
}): Promise<CompanyIntro> {
  const domain = getDomainFromEmail(params.email);
  const freemail = isFreemail(domain);

  let baseName =
    params.orgNameRaw?.trim() ||
    companyNameFromDomain(domain) ||
    "deinem Unternehmen";

  if (freemail || !domain) {
    return {
      companyName: baseName,
      oneLiner: "ein Unternehmen in deinem Bereich",
      topics: [],
    };
  }

  const snippets = await searchCompanyWebContext({
    companyName: baseName,
    domain,
  });

  if (!snippets.length) {
    return {
      companyName: baseName,
      oneLiner: "ein Unternehmen in deinem Bereich",
      topics: [],
    };
  }

  const snippetsText = snippets
    .map(
      (s, idx) =>
        `#${idx + 1}: ${s.title}\nURL: ${s.url}\nSnippet: ${
          s.description ?? "—"
        }\n`
    )
    .join("\n\n");

  const systemPrompt = `
Du extrahierst aus Web-Snippets kompakte Firmenprofile.
Antworte als JSON mit Feldern: companyName, industry, oneLiner, topics.
Sprache: Deutsch.
`.trim();

  const userPrompt = `
Lies diese Suchergebnisse zu einem Unternehmen:

${snippetsText}

Gib zurück:
- companyName: Firmenname (falls unsicher, nimm "${baseName}")
- industry: kurze Branchenbeschreibung ("IT-Dienstleistungen", "Logistik", ...)
- oneLiner: ein prägnanter Satz (max. 30–40 Wörter), der das Unternehmen beschreibt
- topics: 2–4 aktuelle Themen/Schwerpunkte als kurze Stichworte

Antwort NUR als JSON.
`.trim();

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 400,
  });

  const text = response.output_text;

  try {
    const parsed = JSON.parse(text) as CompanyIntro;
    return {
      companyName: parsed.companyName || baseName,
      industry: parsed.industry,
      oneLiner: parsed.oneLiner || "ein Unternehmen in deinem Bereich",
      topics: parsed.topics ?? [],
    };
  } catch (e) {
    console.error("CompanyIntro JSON parse error", e, text);
    return {
      companyName: baseName,
      oneLiner: "ein Unternehmen in deinem Bereich",
      topics: [],
    };
  }
}
