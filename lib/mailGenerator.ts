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
type WebProduct = "isae3402" | "bsi_c5" | "soc1" | "soc2" | "isae3000" | "ps951" | "grc_soc2" | "iso27001" | "iso9001" | "nis2" | "grc_c5" | "dora" | "other";

function normalizeProduct(product: string): WebProduct {
  const p = product.toLowerCase().replace(/\s+/g, "");

  if (p.includes("isae3402") || p.includes("isae-3402") || p.includes("isae 3402")) return "isae3402";
  if (p.includes("bsic5") || p.includes("bsi-c5") || p.includes("bsi c5")) return "bsi_c5";
  if (p.includes("soc1") || p.includes("soc-1") || p.includes("soc 1")) return "soc1";
  if (p.includes("soc2") || p.includes("soc-2") || p.includes("soc 2")) return "soc2";
  if (p.includes("isae3000") || p.includes("isae-3000") || p.includes("isae 3000")) return "isae3000";
  if (p.includes("ps951") || p.includes("ps-951") || p.includes("ps 951")) return "ps951";
  if (p.includes("grc_essentials_soc_2") || p.includes("grc essentials soc 2") || p.includes("grc essentials soc2")) return "grc_soc2";
  if (p.includes("iso27001") || p.includes("iso 27001") || p.includes("iso-27001")) return "iso27001";
  if (p.includes ("iso9001") || p.includes ("iso-9001") || p.includes ("iso 9001")) return "iso9001";
  if (p.includes ("nis2") || p.includes ("nis 2") || p.includes ("nis-2")) return "nis2";
  if (p.includes ("grc_essentials_bsi_c5") || p.includes("grc essentials bsi c5") || p.includes("grc essentials bsic5")) return "grc_c5";
  if (p.includes("dora")) return "dora";

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
      case "isae3000":
        return {
          label: "ISAE 3000",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ISAE 3000 angefragt.`,
          relevanceSentence:
            "SOC 2 ist relevant, wenn ihr Services mit hohen Anforderungen an Sicherheit, Verfügbarkeit oder Datenschutz bietet und dies gegenüber Kunden strukturiert belegen wollt.",
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
      case "isae3000":
        return {
          label: "ISAE 3000",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ISAE 3000 angefragt.`,
          relevanceSentence:
            "ISAE 3000 ist wichtig, wenn ihr Nicht-Finanzprozesse nachweisen müsst – z. B. Datenschutz, Informationssicherheit oder Compliance –, und dafür eine unabhängige Prüfung benötigt.",
        };

      case "ps951":
        return {
          label: "PS 951",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu PS 951 angefragt.`,
          relevanceSentence:
            "PS 951 ist besonders relevant für Dienstleister, deren Leistungen unter ein internes Kontrollsystem fallen und deren Prozesse sicher und prüfbar gestaltet sein müssen.",
        };

      case "grc_soc2":
        return {
          label: "GRC Essentials SOC 2",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu GRC Essentials SOC 2 angefragt.`,
          relevanceSentence:
            "GRC Essentials SOC 2 unterstützt euch dabei, die Anforderungen eines SOC-2-Audits strukturiert vorzubereiten – inklusive Risikomanagement, Controls und Dokumentation.",
        };

      case "iso27001":
        return {
          label: "ISO 27001",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ISO 27001 angefragt.`,
          relevanceSentence:
            "ISO 27001 ist relevant, wenn ihr ein Informationssicherheitsmanagementsystem (ISMS) aufbauen oder zertifizieren lassen möchtet, um Sicherheit und Compliance nachzuweisen.",
        };

      case "iso9001":
        return {
          label: "ISO 9001",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu ISO 9001 angefragt.`,
          relevanceSentence:
            "ISO 9001 ist besonders wichtig, wenn ihr ein wirksames Qualitätsmanagementsystem benötigt, um Prozesse konsistent, effizient und kundenzentriert zu gestalten.",
        };

      case "nis2":
        return {
          label: "NIS 2",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu NIS 2 angefragt.`,
          relevanceSentence:
            "NIS 2 ist relevant, wenn ihr kritische oder wichtige Dienstleistungen anbietet und neue Anforderungen an Sicherheit, Risikomanagement und Meldepflichten erfüllen müsst.",
        };

      case "grc_c5":
        return {
          label: "GRC Essentials BSI C5",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu GRC Essentials BSI C5 angefragt.`,
          relevanceSentence:
            "GRC Essentials BSI C5 unterstützt euch dabei, die Anforderungen des BSI-C5-Standard effizient umzusetzen – inklusive Controls, Dokumentation und Auditvorbereitung.",
        };

      case "dora":
        return {
          label: "DORA",
          requestSentence: `Der Lead hat über das Webformular Informationsmaterial zu DORA angefragt.`,
          relevanceSentence:
            "DORA betrifft Finanzunternehmen und ICT-Dienstleister, die digitale Betriebsstabilität nachweisen müssen – inklusive Risikomanagement, Berichterstattung und Resilienzmaßnahmen.",
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

  // Nicht-DE in Englisch 
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
    case "isae3000":
      return {
        label: "ISAE 3000",
        requestSentence: `The lead used the web form to request information about ISAE 3000.`,
        relevanceSentence:
          "ISAE 3000 is relevant when you need assurance on non-financial processes — such as privacy, information security, or compliance — through an independent audit.",
      };

    case "ps951":
      return {
        label: "PS 951",
        requestSentence: `The lead used the web form to request information about PS 951.`,
        relevanceSentence:
          "PS 951 is important for service providers whose processes must follow a structured internal control system and be transparent and auditable.",
      };

    case "grc_soc2":
      return {
        label: "GRC Essentials SOC 2",
        requestSentence: `The lead used the web form to request information about GRC Essentials SOC 2.`,
        relevanceSentence:
          "GRC Essentials SOC 2 helps you prepare for a SOC 2 audit by structuring risk management, controls, and documentation in a practical framework.",
      };

    case "iso27001":
      return {
        label: "ISO 27001",
        requestSentence: `The lead used the web form to request information about ISO 27001.`,
        relevanceSentence:
          "ISO 27001 is relevant if you need to build or certify an Information Security Management System (ISMS) to demonstrate security and compliance.",
      };

    case "iso9001":
      return {
        label: "ISO 9001",
        requestSentence: `The lead used the web form to request information about ISO 9001.`,
        relevanceSentence:
          "ISO 9001 matters if you need an effective quality management system to ensure consistent, efficient, and customer-focused processes.",
      };

    case "nis2":
      return {
        label: "NIS 2",
        requestSentence: `The lead used the web form to request information about NIS 2.`,
        relevanceSentence:
          "NIS 2 is important if you provide essential or important services and must comply with new requirements for security, risk management, and incident reporting.",
      };

    case "grc_c5":
      return {
        label: "GRC Essentials BSI C5",
        requestSentence: `The lead used the web form to request information about GRC Essentials BSI C5.`,
        relevanceSentence:
          "GRC Essentials BSI C5 helps you implement the BSI C5 standard efficiently — including controls, documentation, and audit preparation.",
      };

    case "dora":
      return {
        label: "DORA",
        requestSentence: `The lead used the web form to request information about DORA.`,
        relevanceSentence:
          "DORA applies to financial entities and ICT service providers who must demonstrate digital operational resilience, including risk management, reporting, and operational continuity.",
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

PERSPEKTIVE:
- Schreibe aus Sicht des Anbieters, der das Webformular bereitstellt (also „wir“ schreiben an den Lead).
- Verwende Formulierungen wie „unser Webformular“ oder neutral „das Webformular auf unserer Website“.
- Verwende NICHT „euer Webformular“ oder Formulierungen, die so klingen, als würde der Lead sich selbst anschreiben.

ANREDE:
- Wenn ein Name vorhanden ist, beginne jede E-Mail mit einer Anrede:
  - Deutsch: "Hallo <Vorname> <Nachname>,"
  - Englisch: "Hi <First name> <Last Name>,"
  - Niederländisch/Schwedisch: passende moderne Sie-Anrede in der jeweiligen Sprache.
- Wenn KEIN sinnvoller Name vorhanden ist, nutze eine neutrale Anrede:
  - Deutsch: "Hallo,"
  - Englisch: "Hi there,"
- Verwende NIEMALS die E-Mail-Adresse in der Anrede.

WICHTIG:
STILVORGABEN:
- Im Deutschen immer SIE-Form verwenden ("Sie", "Ihr", "Ihre" etc.) und diese Pronomen großschreiben.
- In anderen Sprachen eine professionelle, respektvolle Ansprache verwenden.
- Professionell-sympathisch, modern, locker, aber klar.
- Kein Corporate-Sprech, kein Blabla.
- Kurze Sätze, klare Botschaften.
- Jede Mail maximal 130–170 Wörter.
- 2–3 Absätze.
- Wenn sinnvoll: 1 kleine Bullet-Liste.
- Jede Mail soll so wirken, als wäre sie wirklich individuell geschrieben.
- Keine Grußformeln (die Signatur wird im Template ergänzt).

SPAM-VERMEIDUNG:
- Formuliere Betreffzeilen und Inhalte so, dass sie möglichst nicht im Spam landen.
- Vermeide:
  - reißerische Sprache ("jetzt zuschlagen", "nur heute", "letzte Chance", "unglaubliches Angebot")
  - komplett GROSSGESCHRIEBENE Wörter
  - mehrere Ausrufezeichen ("!!", "!!!")
  - übertriebene Dringlichkeit oder künstliche Verknappung.
- Betreff und Inhalt sollen ehrlich, sachlich und vertrauenswürdig wirken.
- Verwende nur dezente Emojis oder lasse Emojis komplett weg.

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
