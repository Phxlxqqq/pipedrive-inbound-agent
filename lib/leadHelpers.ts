// lib/leadHelpers.ts
const FREEMAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com",
  "live.com", "yahoo.com", "web.de", "gmx.de", "icloud.com", "t-online.de",
];

export function getDomainFromEmail(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  return parts[1].toLowerCase();
}

export function isFreemail(domain: string | null): boolean {
  if (!domain) return true;
  return FREEMAIL_DOMAINS.includes(domain);
}

export function companyNameFromDomain(domain: string | null): string | null {
  if (!domain) return null;
  const withoutTld = domain.split(".")[0]; // "acme-industries"
  if (!withoutTld) return null;
  const raw = withoutTld.replace(/[-_]/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
