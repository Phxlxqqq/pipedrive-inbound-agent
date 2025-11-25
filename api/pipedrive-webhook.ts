// api/pipedrive-webhook.ts

import { env } from "../lib/env";
import { buildCompanyIntro } from "../lib/companyEnricher";
import type { CompanyIntro } from "../lib/companyEnricher";
import { generateFollowupMails } from "../lib/mailGenerator";
import { updateDeal, getPerson } from "../lib/pipedrive";

export const config = {
  runtime: "edge",
};

// --- Basic Spam-Helper ----------------------------------------------------

// Sehr einfache Liste von Trashmail-Domains (kannst du später erweitern)
// Behandelt sowohl klassische Wegwerf-Adressen als auch gängige Freemail-Anbieter als "nicht B2B"
const TRASHMAIL_DOMAINS = [
  // Klassische Wegwerf-/Temp-Mail-Domains
  "mailinator.com",
  "sharklasers.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "discard.email",
  "temp-mail.org",
  "tempmail.com",
  "getnada.com",
  "trashmail.com",
  "dispostable.com",
  "maildrop.cc",
  "moakt.com",
  "dropmail.me",

  // Große Freemail-Provider (B2C)
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.de",
  "icloud.com",
  "me.com",
  "aol.com",

  // Deutsche Freemail-Provider
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "freenet.de",
  "mail.de",
  "posteo.de",

  // Privacy-/Secure-Mail (typischerweise nicht Unternehmensdomain)
  "proton.me",
  "protonmail.com",
  "tutanota.com",
];

function getEmailDomain(email: string): string | null {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return null;
  return email.slice(atIndex + 1).trim().toLowerCase();
}

function isTrashmailDomain(domain: string | null): boolean {
  if (!domain) return false;
  return TRASHMAIL_DOMAINS.some((d) => domain.endsWith(d));
}

function isSuspiciousName(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();

  if (!n) return true; // komplett leer

  // Nur Zahlen → verdächtig
  if (/^\d+$/.test(n)) return true;

  // Sehr kurz
  if (n.length <= 1) return true;

  // Klassiker für Tests
  const TEST_PATTERNS = ["test", "tester", "asdf", "qwerty", "xxx", "abc"];
  if (TEST_PATTERNS.includes(n)) return true;

  return false;
}

// Vorname bereinigen: keine E-Mail, keine reinen Sonderzeichen, etc.
function sanitizeFirstName(
  name: string | undefined | null
): string | undefined {
  if (!name) return undefined;

  const n = String(name).trim();
  if (!n) return undefined;
  if (n.length < 2) return undefined;

  // Wenn es wie eine E-Mail aussieht → nicht als Vorname verwenden
  if (n.includes("@")) return undefined;

  // Wenn gar keine Buchstaben drin sind → auch nicht verwenden
  if (!/[a-zA-ZäöüÄÖÜ]/.test(n)) return undefined;

  return n;
}

// Welche Sprachen unterstützen wir?
type LeadLanguage = "de" | "en" | "nl" | "sv";

// Hilfsfunktion: baut ein sauberes, professionelles Enrichment-Summary
function buildEnrichmentSummary(
  ci: CompanyIntro,
  language: LeadLanguage
): string {
  const parts: string[] = [];

  const isGerman = language === "de";

  // 1. Firmenname
  parts.push(ci.companyName);

  // 2. Branche / Industry
  if (ci.industry && ci.industry.toLowerCase() !== "unbekannt") {
    parts.push(
      isGerman ? `Branche: ${ci.industry}` : `Industry: ${ci.industry}`
    );
  }

  // 3. One-Liner (nur, wenn kein generischer Fallback)
  if (ci.oneLiner && ci.oneLiner !== "ein Unternehmen in deinem Bereich") {
    parts.push(ci.oneLiner);
  }

  // 4. Themen / Topics
  if (ci.topics && ci.topics.length > 0) {
    parts.push(
      isGerman
        ? `Themen: ${ci.topics.join(", ")}`
        : `Topics: ${ci.topics.join(", ")}`
    );
  }

  // 5. Fallback
  if (parts.length === 1) {
    parts.push(
      isGerman
        ? "Profil aktuell nur teilweise verfügbar — weitere Infos folgen."
        : "Profile currently only partially available — more details to follow."
    );
  }

  return parts.join(" | ");
}

// Produkt aus Titel extrahieren: alles vor " Lead"
function detectProductFromTitle(title: string): string {
  const idx = title.toLowerCase().indexOf(" lead");
  if (idx > 0) {
    return title.slice(0, idx).trim();
  }
  return title.trim();
}

// Sprache aus Titel + ggf. Domain ableiten
function detectLanguageFromTitleAndEmail(
  title: string,
  email: string
): LeadLanguage {
  const t = title.toLowerCase();
  const domain = email.split("@")[1]?.toLowerCase() || "";

  // Land-Codes im Titel (mit/ohne Leerzeichen)
  if (t.includes(" nl ") || t.endsWith(" nl") || t.includes(" niederlande")) {
    return "nl";
  }
  if (t.includes(" swe ") || t.endsWith(" swe") || t.includes(" schweden")) {
    return "sv";
  }
  if (
    t.includes(" uk ") ||
    t.endsWith(" uk") ||
    t.includes(" united kingdom")
  ) {
    return "en";
  }
  if (
    t.includes(" de ") ||
    t.endsWith(" de") ||
    t.includes(" ger ") ||
    t.endsWith(" ger") ||
    t.includes(" deutschland")
  ) {
    return "de";
  }

  // Fallback über Domain
  if (domain.endsWith(".nl")) return "nl";
  if (domain.endsWith(".se")) return "sv";
  if (domain.endsWith(".de")) return "de";
  if (domain.endsWith(".co.uk") || domain.endsWith(".uk")) return "en";

  // Default: Deutsch
  return "de";
}

export default async function handler(req: Request): Promise<Response> {
  console.log("[WEBHOOK] Hit", req.method, req.url);

  if (req.method !== "POST") {
    console.log("[WEBHOOK] Method not allowed:", req.method);
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Secret aus Query
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");

    if (secret !== env.webhookSecret) {
      console.warn("[WEBHOOK] Wrong secret", { got: secret });
      return new Response("Forbidden", { status: 403 });
    }

    const payload: any = await req.json();
    console.log("[WEBHOOK] Incoming payload:", JSON.stringify(payload));

    const current: any =
      payload.current || payload.data || payload.deal || payload.meta?.current;

    if (!current) {
      console.error("[WEBHOOK] No deal in payload");
      return new Response("No deal", { status: 400 });
    }

    const dealId: number = current.id;
    console.log("[WEBHOOK] Current deal", {
      id: dealId,
      pipeline_id: current.pipeline_id,
      stage_id: current.stage_id,
      product_name: current.product_name,
      title: current.title,
    });

    const webformTitle: string =
      current.title || current.subject || "Anfrage über Webformular";

    // Optional: Pipeline-Filter
    if (env.pipelineId && String(current.pipeline_id) !== env.pipelineId) {
      console.log("[WEBHOOK] Ignored (pipeline mismatch)", {
        dealPipeline: current.pipeline_id,
        expected: env.pipelineId,
      });
      return new Response("Ignored (pipeline)", { status: 200 });
    }

    // Optional: Stage-Filter
    if (env.stageId && String(current.stage_id) !== env.stageId) {
      console.log("[WEBHOOK] Ignored (stage mismatch)", {
        dealStage: current.stage_id,
        expected: env.stageId,
      });
      return new Response("Ignored (stage)", { status: 200 });
    }

    // Optional: Produkt-Filter – falls du das über Titel/Produkt triggern willst
    // if (env.productTrigger) {
    //   const productName = String(current.product_name || current.title || "");
    //   if (!productName.includes(env.productTrigger)) {
    //     console.log("[WEBHOOK] Ignored (product mismatch)", {
    //       productName,
    //       trigger: env.productTrigger,
    //     });
    //     return new Response("Ignored (product)", { status: 200 });
    //   }
    // }

    // ---------- PERSON & EMAIL ROBUST ERMITTELN ----------

    const personRef: any = current.person_id || current.person || null;

    let email: string | undefined;
    let leadFirstName: string | undefined;
    let personName: string | undefined;
    let orgNameFromPerson: string | null = null;

    // 1) Falls im Webhook schon ein Person-Objekt steckt
    if (personRef && typeof personRef === "object") {
      personName = personRef.name;

      const rawFirstNameFromPerson =
        personRef.first_name ||
        (personRef.name && String(personRef.name).split(" ")[0]);

      leadFirstName = sanitizeFirstName(rawFirstNameFromPerson);

      email =
        personRef.email?.[0]?.value ||
        personRef.primary_email ||
        current.email ||
        current.person_email;

      // Org-Name evtl. direkt am Person-Objekt
      orgNameFromPerson =
        personRef.org_name ||
        (personRef.org_id && typeof personRef.org_id === "object"
          ? personRef.org_id.name
          : null) ||
        null;
    }

    // 2) Personen-ID extrahieren
    let personId: number | undefined;

    if (typeof personRef === "number") {
      personId = personRef;
    } else if (
      personRef &&
      typeof personRef === "object" &&
      typeof personRef.value === "number"
    ) {
      // übliches Pipedrive-Format: { value: 123, name: "Anna Beispiel" }
      personId = personRef.value;
    }

    // 3) Wenn wir noch keine E-Mail haben, Person via API nachladen
    if (!email && personId) {
      try {
        const person: any = await getPerson(personId);
        console.log("[WEBHOOK] Loaded person from API", person);

        personName = person.name || personName;

        const rawFirstNameFromApi =
          person.first_name ||
          leadFirstName ||
          (person.name && person.name.split(" ")[0]);

        leadFirstName =
          sanitizeFirstName(rawFirstNameFromApi) || leadFirstName;

        if (person.email && person.email.length > 0) {
          email = person.email[0].value;
        } else if (person.primary_email) {
          email = person.primary_email;
        }

        // Org-Name auch hier aus der Person ziehen
        orgNameFromPerson =
          person.org_name ||
          (person.org_id && typeof person.org_id === "object"
            ? person.org_id.name
            : null) ||
          orgNameFromPerson;
      } catch (e) {
        console.error("[WEBHOOK] Failed to load person", e);
      }
    }

    // 4) Wenn wir IMMER noch keine E-Mail haben → abbrechen
    if (!email) {
      console.error("[WEBHOOK] No email for deal", { dealId });
      return new Response("No email", { status: 200 });
    }

    // leadFirstName Fallback
    if (!leadFirstName && personName) {
      leadFirstName = sanitizeFirstName(personName.split(" ")[0]);
    }

    // ---------- BASIC SPAM CHECK ----------

    const domain = getEmailDomain(email);
    const suspiciousName = isSuspiciousName(leadFirstName);

    if (isTrashmailDomain(domain) || suspiciousName) {
      console.log("[SPAM] Lead blocked", {
        dealId,
        email,
        domain,
        leadFirstName,
        reason: {
          trashmail: isTrashmailDomain(domain),
          suspiciousName,
        },
      });
      // Wir antworten mit 200, damit Pipedrive den Webhook nicht retried
      return new Response("Spam ignored", { status: 200 });
    }

    // ---------- ORG-NAME ERMITTELN ----------

    // 1. aus Deal
    let orgNameRaw: string | null =
      current.org_name ||
      (current.org_id && typeof current.org_id === "object"
        ? current.org_id.name
        : null) ||
      null;

    // 2. Fallback: aus Person (wenn Deal nichts hatte)
    if (!orgNameRaw && orgNameFromPerson) {
      orgNameRaw = orgNameFromPerson;
    }

    console.log("[WEBHOOK] Lead data", {
      email,
      leadFirstName,
      orgNameRaw,
      webformTitle,
    });

    const product = detectProductFromTitle(webformTitle);
    const language = detectLanguageFromTitleAndEmail(webformTitle, email);

    console.log("[WEBHOOK] Routing lead", { product, language, webformTitle });

    // 1) Company-Enrichment über Brave
    const companyIntro = await buildCompanyIntro({
      email,
      orgNameRaw,
    });

    console.log("[WEBHOOK] CompanyIntro", companyIntro);

    // 2) Follow-up-Mails generieren (inkl. Subjects)
    const mails = await generateFollowupMails({
      webformTitle,
      leadEmail: email,
      leadFirstName,
      companyIntro,
      product,
      language,
    });

    console.log("[WEBHOOK] Generated mails", {
      firstLen: mails.first?.length,
      secondLen: mails.second?.length,
      thirdLen: mails.third?.length,
      firstSubject: mails.first_subject,
      secondSubject: mails.second_subject,
      thirdSubject: mails.third_subject,
    });

    // 3) Enrichment-Summary bauen
    const enrichmentSummary = buildEnrichmentSummary(companyIntro, language);
    console.log("[WEBHOOK] Enrichment summary", enrichmentSummary);

    // 4) Deal-Felder schreiben
    const updatePayload: Record<string, any> = {
      [env.fields.enrichmentSummary]: enrichmentSummary,
      [env.fields.companyIndustry]: companyIntro.industry ?? "",
      [env.fields.emailIntro1]: mails.first,
      [env.fields.emailIntro2]: mails.second,
      [env.fields.emailIntro3]: mails.third,
      // neue Subject-Felder:
      [env.fields.emailSubject1]: mails.first_subject,
      [env.fields.emailSubject2]: mails.second_subject,
      [env.fields.emailSubject3]: mails.third_subject,
    };

    console.log("[WEBHOOK] Update payload", updatePayload);

    await updateDeal(dealId, updatePayload);

    console.log("[WEBHOOK] Done for deal", dealId);
    return new Response("ok", { status: 200 });
  } catch (err: any) {
    console.error("[WEBHOOK] Unhandled error", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
