import { parsePhoneNumber, CountryCode } from 'libphonenumber-js';

/**
 * Normalizes email: trim and toLowerCase
 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/**
 * Normalizes LinkedIn URL to slug.
 * Rules:
 * - Remove protocol
 * - Remove query params
 * - Detect /in/
 * - Extract slug
 * - toLowerCase
 */
export function normalizeLinkedIn(url: string): string | null {
    try {
        let cleanUrl = url.trim().toLowerCase();

        // Remove common prefixes for easier parsing if not a full URL
        if (cleanUrl.startsWith('www.')) cleanUrl = 'https://' + cleanUrl;
        if (!cleanUrl.startsWith('http')) {
            cleanUrl = 'https://' + cleanUrl;
        }

        const urlObj = new URL(cleanUrl);
        // Ensure it's a linkedin domain
        if (!urlObj.hostname.includes('linkedin.com')) {
            // If not a linkedin domain, check if it's just a slug
            if (!url.includes('/') && !url.includes('.')) {
                return url.trim().toLowerCase();
            }
            return null;
        }

        const pathSegments = urlObj.pathname.split('/').filter(Boolean);

        // Find 'in', 'company', or 'school' segment and get the next one
        const lookup = ['in', 'company', 'school'];
        const foundIndex = pathSegments.findIndex(seg => lookup.includes(seg));

        if (foundIndex !== -1 && pathSegments[foundIndex + 1]) {
            return pathSegments[foundIndex + 1].split('?')[0].split('#')[0];
        }

        // If it's just linkedin.com/slug (less common but possible)
        if (pathSegments.length === 1 && !lookup.includes(pathSegments[0])) {
            return pathSegments[0].split('?')[0].split('#')[0];
        }

        return null;
    } catch (e) {
        // If URL parsing fails, check if simple slug
        const trimmed = url.trim().toLowerCase();
        if (!trimmed.includes('/') && !trimmed.includes('.') && trimmed.length > 0) {
            return trimmed;
        }
        return null;
    }
}

/**
 * Normalizes phone number to E.164.
 *
 * Default country is US (+1): the data is US-centric, and an unqualified
 * national number must be assumed to belong to some country. A wrong default
 * silently mangles every bare number (e.g. a US 703… became +52703… under the
 * old MX default), which breaks phone-based DNC matching. Numbers already in
 * E.164 (with a leading +) keep their own country code regardless of this.
 */
export function normalizePhone(phone: string, defaultCountry: CountryCode = 'US'): { e164: string, national: string } | null {
    try {
        const phoneNumber = parsePhoneNumber(phone, defaultCountry);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                e164: phoneNumber.number, // E.164
                national: phoneNumber.nationalNumber as string // formatNational() might include spaces/dashes, we want digits usually?
                // User said: "phone_national (sin LADA)". 
                // library's .nationalNumber is usually the number without country code.
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Normalizes domain: trim, toLowerCase, remove protocol/www
 * e.g. "https://www.google.com/" -> "google.com"
 */
export function normalizeDomain(domain: string): string | null {
    try {
        let cleanDomain = domain.trim().toLowerCase();

        // Remove protocol
        if (cleanDomain.startsWith('http://')) cleanDomain = cleanDomain.slice(7);
        if (cleanDomain.startsWith('https://')) cleanDomain = cleanDomain.slice(8);

        // Remove www.
        if (cleanDomain.startsWith('www.')) cleanDomain = cleanDomain.slice(4);

        // Remove trailing slash
        if (cleanDomain.endsWith('/')) cleanDomain = cleanDomain.slice(0, -1);

        // Basic validation: should have at least one dot
        if (!cleanDomain.includes('.')) return null;

        return cleanDomain;
    } catch (e) {
        return null;
    }
}
