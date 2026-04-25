import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectTechnologies } from "../../src/services/tech-detector.service";

function makeMockFetch(html: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(html),
  });
}

describe("detectTechnologies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("CMS detection", () => {
    it("detects WordPress via /wp-content/", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="stylesheet" href="/wp-content/themes/my-theme/style.css">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.cms).toBe("WordPress");
    });

    it("detects WordPress with version from generator meta tag", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta name="generator" content="WordPress 6.4" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.cms).toBe("WordPress 6.4");
    });

    it("detects Shopify via cdn.shopify.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://cdn.shopify.com/s/files/1/app.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.cms).toBe("Shopify");
    });
  });

  describe("Analytics detection", () => {
    it("detects Google Analytics GA4 via gtm script URL", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.analytics).toContain("Google Analytics (GA4)");
    });

    it("detects multiple analytics tools when both GA4 and Facebook Pixel are present", async () => {
      const html = `
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-XYZ456"></script>
        <script>
          !function(f,b,e,v,n,t,s){fbq('init', '1234567890');}
        </script>
        <script async defer src="https://connect.facebook.net/en_US/fbevents.js"></script>
      `;
      vi.stubGlobal("fetch", makeMockFetch(html));
      const result = await detectTechnologies("https://example.com");
      expect(result.analytics).toContain("Google Analytics (GA4)");
      expect(result.analytics).toContain("Facebook Pixel");
    });
  });

  describe("Tag Manager detection", () => {
    it("detects Google Tag Manager via gtm.js URL", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX123"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.tag_managers).toContain("Google Tag Manager");
    });
  });

  describe("Marketing detection", () => {
    it("detects HubSpot via hs-scripts.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script type="text/javascript" src="//js.hs-scripts.com/123.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.marketing).toContain("HubSpot");
    });
  });

  describe("Payments detection", () => {
    it("detects Stripe via js.stripe.com/v3", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://js.stripe.com/v3/"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.payments).toContain("Stripe");
    });
  });

  describe("CDN detection", () => {
    it("detects Cloudflare via cdnjs.cloudflare.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.cdn).toContain("Cloudflare");
    });
  });

  describe("Ecommerce detection", () => {
    it("detects WooCommerce when woocommerce pattern is present with WordPress", async () => {
      const html = `
        <link rel="stylesheet" href="/wp-content/themes/storefront/style.css">
        <script src="/wp-content/plugins/woocommerce/assets/js/frontend/cart.min.js"></script>
      `;
      vi.stubGlobal("fetch", makeMockFetch(html));
      const result = await detectTechnologies("https://example.com");
      expect(result.ecommerce).toBe("WooCommerce");
    });
  });

  describe("Empty/no-match HTML", () => {
    it("returns empty values when no patterns match", async () => {
      vi.stubGlobal("fetch", makeMockFetch("<html><body><p>Hello world</p></body></html>"));
      const result = await detectTechnologies("https://example.com");
      expect(result.cms).toBe("");
      expect(result.ecommerce).toBe("");
      expect(result.analytics).toEqual([]);
      expect(result.tag_managers).toEqual([]);
      expect(result.marketing).toEqual([]);
      expect(result.advertising).toEqual([]);
      expect(result.payments).toEqual([]);
      expect(result.cdn).toEqual([]);
      expect(result.seo).toEqual([]);
      expect(result.privacy).toEqual([]);
      expect(result.otros).toEqual([]);
      expect(result.resumen).toBe("");
    });
  });

  describe("Resumen format", () => {
    it("builds resumen as pipe-separated list of detected technologies", async () => {
      const html = `
        <link rel="stylesheet" href="/wp-content/themes/twentytwenty/style.css">
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
        <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX123"></script>
      `;
      vi.stubGlobal("fetch", makeMockFetch(html));
      const result = await detectTechnologies("https://example.com");
      expect(result.resumen).toBe("WordPress | Google Analytics (GA4) | Google Tag Manager");
    });
  });

  describe("Error handling", () => {
    it("throws 'Timeout al obtener la URL' when fetch throws AbortError", async () => {
      const abortError = new DOMException("Aborted", "AbortError");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
      await expect(detectTechnologies("https://example.com")).rejects.toThrow("Timeout al obtener la URL");
    });

    it("throws 'HTTP 403 desde la URL' when response status is 403", async () => {
      vi.stubGlobal("fetch", makeMockFetch("Forbidden", 403));
      await expect(detectTechnologies("https://example.com")).rejects.toThrow("HTTP 403 desde la URL");
    });

    it("throws 'URL inválida' when an invalid URL is passed", async () => {
      await expect(detectTechnologies("not-a-url")).rejects.toThrow("URL inválida");
    });
  });
});
