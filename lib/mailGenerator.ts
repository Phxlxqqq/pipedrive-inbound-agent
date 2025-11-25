// lib/mailGenerator.ts
import { openai } from "./openaiClient";
import { CompanyIntro } from "./companyEnricher";

export type GeneratedMails = {
  first: string;
  second: string;
  third: string;
  first_subject: string;
  second_subject: string;
  third_subject: string;
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

/**
 * Webform-Typen (unabhängig vom Produkt)
 */
type WebformKind = "whitepaper" | "demo" | "contact" | "other";

function detectWebformKind(title: string): WebformKind {
  const t = title.toLowerCase();

  if (t.includes("whitepaper") || t.includes("ebook") || t.includes("e-book")) {
    return "whitepaper";
  }
  if (t.includes("demo")) {
    return "demo";
  }
  if (
    t.includes("kontakt") ||
    t.includes("contact") ||
    t.includes("anfrage") ||
    t.includes("request")
  ) {
    return "contact";
  }

  return "other";
}

function getWebformContext(
  webformTitle: string,
  language: LeadLanguage
): {
  actionDescription: string; // 1–2 Sätze, was der Lead gemacht hat
  shortLabel: string; // Kurzlabel für die Anfrage
} {
  const kind = detectWebformKind(webformTitle);
  const t = webformTitle;

  if (language === "de") {
    switch (kind) {
      case "whitepaper":
        return {
          actionDescription: `Der Lead hat über das Webformular "${t}" ein Whitepaper bzw. Unterlagen angefragt.`,
          shortLabel: "die Whitepaper-Anfrage",
        };
      case "demo":
        return {
          actionDescription: `Der Lead hat über das Webformular "${t}" eine Produkt-Demo angefragt.`,
          shortLabel: "die Demo-Anfrage",
        };
      case "contact":
        return {
          actionDescription: `Der Lead hat über das Webformular "${t}" eine Kontaktanfrage gestellt.`,
          shortLabel: "die Kontaktanfrage",
        };
      default:
        return {
          actionDescription: `Der Lead hat das Webformular "${t}" ausgefüllt und Interesse an weiteren Informationen gezeigt.`,
          shortLabel: "die Anfrage",
        };
    }
  }

  if (language === "en") {
    switch (kind) {
      case "whitepaper":
        return {
          actionDescription: `The lead used the web form "${t}" to request a whitepaper or related materials.`,
          shortLabel: "the whitepaper request",
        };
      case "demo":
        return {
          actionDescription: `The lead used the web form "${t}" to request a product demo.`,
          shortLabel: "the demo request",
        };
      case "contact":
        return {
          actionDescription: `The lead used the web form "${t}" to send a contact request.`,
          shortLabel: "the contact request",
        };
      default:
        return {
          actionDescription: `The lead filled out the web form "${t}" and expressed interest in more information.`,
          shortLabel: "the request",
        };
    }
  }

  // Für NL + SV vorerst generische englische Beschreibungen
  return {
    actionDescription: `The lead submitted the web form "${t}" and showed interest in your offering.`,
    shortLabel: "the request",
  };
}

/**
 * Produktlogik: ISAE 3402, BSI C5, SOC 1, SOC 2 …
 */
type WebProduct = "isae3402" | "bsi_c5" | "soc1" | "soc2" | "other";

function normalizeProduct(product: string): WebProduct {
  const p = product.toLowerCase().replace(/\s+/g, "");

  if (p.includes("isae3402") || p.includes("isae-3402")) return "isae3402";
  if (p.includes("bsic5") || p.includes("bsi-c5")) return "bsi_c5";
  if (p.includes("soc1") || p.includes("soc-1")) return "soc1";
  if (p.includes("soc2") || p.includes("soc-2")) return "soc2";

  return "other";
}

function getProductContext(
  rawProduct: string,
  language: LeadLanguage
): {
  label: string; // z. B. "ISAE 3402"
  requestSentence: string; // Was genau angefragt wurde
  relevanceSentence: string; // Warum relevant
} {
  const kind = normalizeProduct(rawProduct);
  const baseLabel = rawProduct.trim() || "dein Prüfungsstandard";
  const isGerman = language === "de";

  if (isGerman) {
    switch (kind) {
      case "isae3402":
        return {
          label: "ISAE 3402",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ISAE 3402 angefragt.`,
          relevanceSentence:
            "ISAE 3402 ist besonders relevant, wenn ihr Prozesse und Kontrollen gegenüber Kunden oder Prüfern transparent nachweisen müsst, z. B. als Dienstleister oder Outsourcing-Partner.",
        };
      case "bsi_c5":
        return {
          label: "BSI C5",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu BSI C5 angefragt.`,
          relevanceSentence:
            "BSI C5 ist für euch wichtig, wenn ihr Cloud-Dienste anbietet oder nutzt und ein strukturiertes Rahmenwerk für Informationssicherheit und Compliance nachweisen müsst.",
        };
      case "soc1":
        return {
          label: "SOC 1",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu SOC 1 angefragt.`,
          relevanceSentence:
            "SOC 1 ist relevant, wenn eure Services Einfluss auf die Finanzberichterstattung eurer Kunden haben und ihr geprüfte Kontrollen nachweisen müsst.",
        };
      case "soc2":
        return {
          label: "SOC 2",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu SOC 2 angefragt.`,
          relevanceSentence:
            "SOC 2 ist relevant, wenn ihr Services mit hohen Anforderungen an Sicherheit, Verfügbarkeit oder Datenschutz bietet und dies gegenüber Kunden strukturiert belegen wollt.",
        };
      default:
        return {
          label: baseLabel,
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ${baseLabel} angefragt.`,
          relevanceSentence:
            "Der Standard ist typischerweise relevant, wenn ihr euren Kunden gegenüber strukturierte Prozesse und Kontrollen nachweisen wollt.",
        };
    }
  }

  // Nicht-DE in Englisch (kannst du bei Bedarf noch lokalisieren)
  switch (kind) {
    case "isae3402":
      return {
        label: "ISAE 3402",
        requestSentence: `The lead used the web form to request information about ISAE 3402.`,
        relevanceSentence:
          "ISAE 3402 is relevant if you need to demonstrate robust processes and controls to customers or auditors, e.g. as a service provider.",
      };
    case "bsi_c5":
      return {
        label: "BSI C5",
        requestSentence: `The lead used the web form to request information about BSI C5.`,
        relevanceSentence:
          "BSI C5 matters if you provide or use cloud services and need a structured framework for information security and compliance.",
      };
    case "soc1":
      return {
        label: "SOC 1",
        requestSentence: `The lead used the web form to request information about SOC 1.`,
        relevanceSentence:
          "SOC 1 is relevant if your services affect your customers’ financial reporting and you need audited controls.",
      };
    case "soc2":
      return {
        label: "SOC 2",
        requestSentence: `The lead used the web form to request information about SOC 2.`,
        relevanceSentence:
          "SOC 2 is relevant if you provide services with strong requirements around security, availability or privacy.",
      };
    default:
      return {
        label: baseLabel,
        requestSentence: `The lead used the web form to request information about ${baseLabel}.`,
        relevanceSentence:
          "This kind of standard is usually relevant when you need to demonstrate structured processes and controls to your customers.",
      };
  }
}

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
Du bist ein B2B-Sales-Profi.
Du schreibst personalisierte Follow-up-E-Mails nach einer Webformular-Anfrage.
Antwortformat: JSON mit genau den Feldern:
"first_subject", "first", "second_subject", "second", "third_subject", "third".
Gib NUR JSON zurück, KEINE Erklärtexte, KEINE Markdown-Codeblöcke.
`.trim();

  const topicsText =
    companyIntro.topics && companyIntro.topics.length
      ? companyIntro.topics.join(", ")
      : "keine spezifischen Themen bekannt";

  const industryRaw = companyIntro.industry ?? "unbekannt";

  const webformContext = getWebformContext(webformTitle, language);
  const productContext = getProductContext(product, language);

  const userPrompt = `
Schreibe bitte drei personalisierte Follow-up-E-Mails für einen Lead.

${webformContext.actionDescription}
${productContext.requestSentence}

Nutze unbedingt ALLE verfügbaren Informationen:

Lead:
- E-Mail: ${leadEmail}
- Vorname: ${leadFirstName ?? "unbekannt"} (verwende diesen Vornamen in der Anrede; nutze niemals die E-Mail-Adresse als Name)

Unternehmen:
- Name: ${companyIntro.companyName}
- Kurzprofil (am wichtigsten, bitte als Hauptquelle nutzen): ${companyIntro.oneLiner}
- Branche (nur als grober Hinweis, kann ungenau sein): ${industryRaw}
- Wichtige Themen: ${topicsText}

Anfrage:
- Webform-Titel: "${webformTitle}"
- Formular-Typ: ${webformContext.shortLabel}
- Produkt / Thema: ${productContext.label}

Rahmen:
- ${languageInstruction}
Die Mails werden später in einem Pipedrive-Template verwendet, das bereits die passenden Links (z. B. zu Unterlagen, Whitepaper oder Terminen) enthält.
Du DARFST KEINE Platzhalter oder Links einbauen.
Verweise nur inhaltlich darauf (z. B. „in den Unterlagen findest du…“ oder „im Gespräch können wir…“).

ANREDE:
- Wenn ein Vorname vorhanden ist, beginne jede E-Mail mit einer Anrede:
  - Deutsch: "Hallo <Vorname>,"
  - Englisch: "Hi <First name>,"
  - Niederländisch/Schwedisch: passende moderne Du-Anrede in der jeweiligen Sprache.
- Wenn KEIN sinnvoller Vorname vorhanden ist, nutze eine neutrale Anrede:
  - Deutsch: "Hallo,"
  - Englisch: "Hi there,"
- Verwende NIEMALS die E-Mail-Adresse in der Anrede.

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
- Keine Grußformeln

PERSONALISIERUNG:
- Nutze KURZPROFIL und THEMEN als wichtigste Basis für die Personalisierung.
- Die Branche ist nur ein grober Hinweis und kann ungenau sein. Wenn Branche und Kurzprofil nicht wirklich zusammenpassen, IGNORIERE die Branche und orientiere dich nur am Kurzprofil und den Themen.
- Wenn Themen vorhanden sind: Verwende sie aktiv als Aufhänger.
- Wenn keine klaren Themen erkennbar sind: Fokussiere auf typische Herausforderungen rund um ${productContext.label} (z. B. Nachweispflichten, Prozesse, Sicherheit, Vertrauen von Kunden).
- Du darfst die Branche in der Mail auch komplett weglassen, wenn sie nicht eindeutig passt.
- Mache die Texte deutlich unterschiedlicher Tonalität (zweite Mail etwas konkreter, dritte Mail kürzer und sehr menschlich).

BETREFFZEILEN:
- Erstelle für jede der drei E-Mails auch einen passenden Betreff.
- Der Betreff soll kurz sein (max. 6–9 Wörter).
- VERWENDE NIEMALS den Vornamen im Betreff – auch dann nicht, wenn er bekannt ist.
- Verwende im Betreff keine direkte Anrede ("Hallo", "Hi" etc.).
- Betreff soll klar zum Produkt/Thema ${productContext.label} passen.
- Kein Spam-Stil ("free", "urgent", "limited offer", "!!!" etc.).
- Modern, natürlich klingend, nicht reißerisch.

INHALT:
1) erste Mail („first“)
   - Warm, sympathisch.
   - Deutlicher Bezug auf ${webformContext.shortLabel} und die Anfrage zu ${productContext.label} sowie den Unternehmenskontext.
   - 1–2 Sätze dazu, warum ${productContext.label} für dieses Unternehmen relevant sein könnte:
     ${productContext.relevanceSentence}

2) zweite Mail („second“)
   - Bezug zur ersten Mail.
   - Ein konkreter Nutzenpunkt oder Beispiel, abgestimmt auf Branche/Themen.
   - Warum andere Firmen aus ähnlichen Bereichen von ${productContext.label} profitieren.

3) dritte Mail („third“)
   - Sehr kurz, freundlich, menschlich.
   - „Danach melde ich mich nicht mehr aktiv“.
   - Angebot offen lassen.

Gib NUR ein JSON zurück mit genau diesen Feldern:
{
  "first_subject": "...",
  "first": "...",
  "second_subject": "...",
  "second": "...",
  "third_subject": "...",
  "third": "..."
}
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
