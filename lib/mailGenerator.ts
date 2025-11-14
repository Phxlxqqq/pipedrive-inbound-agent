// lib/mailGenerator.ts
import { openai } from "./openaiClient";
import { CompanyIntro } from "./companyEnricher";

export type GeneratedMails = {
  first: string;
  second: string;
  third: string;
};

// Hilfsfunktion: zieht reines JSON aus einem Text, auch wenn ```json ... ``` drumherum ist
function extractJson(text: string): string {
  let t = text.trim();

  // ggf. Codeblock-Wrapper entfernen (```json ... ```)
  if (t.startsWith("```")) {
    // erste Zeile (``` oder ```json) entfernen
    t = t.replace(/^```[a-zA-Z0-9]*\s*/, "");
    // letztes ``` entfernen
    t = t.replace(/```$/, "").trim();
  }

  // Sicherheit: nur Inhalt zwischen erstem '{' und letztem '}' nehmen
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    t = t.slice(firstBrace, lastBrace + 1);
  }

  return t;
}

export type LeadLanguage = "de" | "en" | "nl" | "sv";

export async function generateFollowupMails(params: {
  webformTitle: string;
  leadEmail: string;
  leadFirstName?: string;
  companyIntro: CompanyIntro;
  product: string;
  language: LeadLanguage;
}): Promise<GeneratedMails> {
  const {
    companyIntro,
    webformTitle,
    leadEmail,
    leadFirstName,
    product,
    language,
  } = params;

  
  const languageInstruction =
  language === "de"
    ? "Schreibe die E-Mails auf DEUTSCH."
    : language === "nl"
    ? "Schreibe die E-Mails auf NIEDERLÄNDISCH."
    : language === "sv"
    ? "Schreibe die E-Mails auf SCHWEDISCH."
    : "Schreibe die E-Mails auf ENGLISCH.";


  const systemPrompt = `
Du bist ein deutschsprachiger B2B-Sales-Profi.
Du schreibst personalisierte Follow-up-E-Mails nach einer Webformular-Anfrage.
Antwortformat: JSON mit "first", "second", "third".
Gib NUR JSON zurück, KEINE Erklärtexte, KEINE Markdown-Codeblöcke.
`.trim();

  const topicsText =
    companyIntro.topics && companyIntro.topics.length
      ? companyIntro.topics.join(", ")
      : "keine spezifischen Themen bekannt";

  const userPrompt = `
Schreibe bitte drei personalisierte Follow-up-E-Mails für einen Lead, der ein Whitepaper angefragt hat.

Nutze unbedingt ALLE verfügbaren Informationen:

Lead:
- E-Mail: ${leadEmail}
- Vorname: ${leadFirstName ?? "unbekannt"}

Unternehmen:
- Name: ${companyIntro.companyName}
- Branche: ${companyIntro.industry ?? "unbekannt"}
- Kurzprofil: ${companyIntro.oneLiner}
- Wichtige Themen: ${topicsText}

Anfrage:
- Webform-Titel: "${webformTitle}"

Rahmen:
- ${languageInstruction}
Die Mails werden später in einem Pipedrive-Template verwendet, das schon Links zu Whitepaper & Kalender enthält.  
Du DARFST KEINE Platzhalter oder Links einbauen.  
Verweise nur inhaltlich darauf („im Whitepaper findest du…“).

WICHTIG:
STILVORGABEN:
- Du-Form, aber professionell-sympathisch.
- Modern, locker, menschlich, nicht geschwollen.
- Kein Corporate-Sprech, kein Blabla.
- Kurze Sätze, klare Botschaften.
- Jede Mail maximal 130–170 Wörter.
- 2–3 Absätze.
- Wenn sinnvoll: 1 kleine Bullet-Liste.
- Jede Mail soll so wirken, als wäre sie wirklich individuell geschrieben.

PERSONALISIERUNG:
- Beziehe dich sicht- und spürbar auf die Branche oder Themen des Unternehmens.
- Wenn Themen vorhanden sind: Verwende sie aktiv als Aufhänger.
- Wenn Branche unbekannt: Fokussiere auf Herausforderungstypen, die oft zu ISAE 3402 passen (z. B. Nachweispflichten, Prozesse, Sicherheit).
- Mache die Texte deutlich unterschiedlicher Tonalität (zweite Mail etwas konkreter, dritte Mail kürzer und sehr menschlich).

INHALT:
1) erste Mail („first“)
   - Warm, sympathisch.
   - Bezug auf Whitepaper-Anfrage + Unternehmenskontext.
   - 1–2 Sätze, warum ISAE 3402 für dieses Unternehmen relevant sein könnte.

2) zweite Mail („second“)
   - Bezug zur ersten Mail.
   - Ein konkreter Nutzenpunkt oder ein Beispiel, abgestimmt auf Branche/Themen.
   - Warum andere Firmen aus ähnlichen Bereichen davon profitieren.

3) dritte Mail („third“)
   - Sehr kurz, freundlich, menschlich.
   - „Danach melde ich mich nicht mehr aktiv“.
   - Angebot offen lassen.

Gib NUR ein JSON zurück:
{
"first": "...",
"second": "...",
"third": "..."
}`.trim();

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 1500,
  });

  const rawText = response.output_text;
  console.log("[MAILGEN] Raw OpenAI output:", rawText);

  const jsonText = extractJson(rawText);
  console.log("[MAILGEN] Extracted JSON:", jsonText);

  try {
    const parsed = JSON.parse(jsonText) as GeneratedMails;
    return parsed;
  } catch (e) {
    console.error("[MAILGEN] Followup JSON parse error", e, jsonText);
    throw new Error("Failed to parse follow-up mails JSON");
  }
}
