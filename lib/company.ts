// /lib/company.ts

export function domainFromEmail(email?: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

const FREEMAIL = new Set([
  'gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com','live.com','icloud.com',
  'gmx.de','web.de','t-online.de','freenet.de','mail.de','proton.me','protonmail.com',
  'hey.com','aol.com','yandex.com','yandex.ru'
]);

const DISPOSABLE = new Set([
  'mailinator.com','10minutemail.com','tempmail.com','guerrillamail.com','trashmail.com'
]);

export function isFreemailOrDisposable(domain?: string | null): boolean {
  if (!domain) return true;
  return FREEMAIL.has(domain) || DISPOSABLE.has(domain);
}

export function inferOrgNameFromDomain(domain: string): string {
  const core = domain
    .replace(/^www\./, '')
    .replace(/^mail\./, '')
    .split('.')
    .slice(0, -1) // TLD weg
    .join('-')
    .replace(/-/g, ' ')
    .trim();

  return core.split(' ')
    .map(w => w ? (w[0].toUpperCase() + w.slice(1)) : '')
    .join(' ') || domain;
}

/** MX-Check – in manchen Serverless-Umgebungen blockiert. */
export async function hasMX(domain: string): Promise<boolean> {
  try {
    const dns = require('dns').promises;
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    // lieber großzügig: nicht fälschlich blocken
    return true;
  }
}
