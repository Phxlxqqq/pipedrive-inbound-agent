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

export async function generateFollowupMails(params: {
  webformTitle: string;
  leadEmail: string;
  leadFirstName?: string;
  companyIntro: CompanyIntro;
}): Promise<GeneratedMails> {
  const { companyIntro, webformTitle, leadEmail, leadFirstName } = params;

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
Kontext:
- Lead-E-Mail: ${leadEmail}
- Vorname (falls bekannt): ${leadFirstName ?? "unbekannt"}
- Firma: ${companyIntro.companyName} (${
    companyIntro.industry ?? "Branche unbekannt"
  })
- Kurzprofil: ${companyIntro.oneLiner}
- Schwerpunktthemen: ${topicsText}
- Webformular-Titel: "${webformTitle}"

Rahmen:
- In der finalen E-Mail-Vorlage in Pipedrive werden automatisch
  ein Kalender-Link und ein Whitepaper-Link eingefügt.
- Du musst keine Links einfügen, sondern nur inhaltlich auf
  das Whitepaper und die Möglichkeit eines kurzen Termins verweisen.

WICHTIG:
- Schreibe so, dass die Texte gut in ein bestehendes Template passen,
  in dem über oder unter dem Text Buttons/Links für Kalender und Whitepaper sind.
- Keine Platzhalter wie {{CALENDAR_LINK}} oder {{WHITEPAPER_LINK}} verwenden.
- Schreibe in der DU-Form, locker-professionell.
- Jede Mail ca. 100–170 Wörter, 2–4 Absätze, gerne mit 1–2 Bullet-Points.

Drei E-Mails:
1) "first":
   - Direkt nach der Anfrage.
   - Bedanken, kurz Bezug auf Firma/Branche und ggf. Themen.
   - Erwähne das angeforderte Whitepaper und lade zu einem kurzen Termin ein.

2) "second":
   - 3–5 Tage später.
   - Kurze Referenz auf die erste Mail.
   - Ein konkreter Use Case, warum das Thema für ${
     companyIntro.companyName
   } spannend ist.
   - Wieder auf Whitepaper und Termin Bezug nehmen.

3) "third":
   - Ca. eine Woche später.
   - Freundlicher, knapper Check-in ("danach melde ich mich nicht mehr aktiv").
   - Angebot offen lassen, dass sich die Person jederzeit melden kann.

Gib NUR ein JSON-Objekt zurück mit den Keys "first", "second", "third".
`.trim();

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
