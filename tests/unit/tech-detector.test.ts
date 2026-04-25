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
      expect(result.technologies).toContain("WordPress");
    });

    it("detects WordPress with version from generator meta tag", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta name="generator" content="WordPress 6.4" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("WordPress 6.4");
    });

    it("detects Shopify via cdn.shopify.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://cdn.shopify.com/s/files/1/app.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("Shopify");
    });
  });

  describe("Analytics detection", () => {
    it("detects Google Analytics GA4 via gtm script URL", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("Google Analytics (GA4)");
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
      expect(result.technologies).toContain("Google Analytics (GA4)");
      expect(result.technologies).toContain("Facebook Pixel");
    });
  });

  describe("Tag Manager detection", () => {
    it("detects Google Tag Manager via gtm.js URL", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX123"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("Google Tag Manager");
    });
  });

  describe("Marketing detection", () => {
    it("detects HubSpot via hs-scripts.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script type="text/javascript" src="//js.hs-scripts.com/123.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("HubSpot");
    });
  });

  describe("Payments detection", () => {
    it("detects Stripe via js.stripe.com/v3", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://js.stripe.com/v3/"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("Stripe");
    });
  });

  describe("CDN detection", () => {
    it("detects Cloudflare via cdnjs.cloudflare.com", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toContain("Cloudflare");
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
      expect(result.technologies).toContain("WooCommerce");
    });
  });

  describe("Empty/no-match HTML", () => {
    it("returns empty values when no patterns match", async () => {
      vi.stubGlobal("fetch", makeMockFetch("<html><body><p>Hello world</p></body></html>"));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toBe("");
      expect(result.scripts).toEqual([]);
      expect(result.links).toEqual([]);
      expect(result.meta).toEqual([]);
    });
  });

  describe("technologies format", () => {
    it("builds technologies as comma-separated list of detected technologies", async () => {
      const html = `
        <link rel="stylesheet" href="/wp-content/themes/twentytwenty/style.css">
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
        <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX123"></script>
      `;
      vi.stubGlobal("fetch", makeMockFetch(html));
      const result = await detectTechnologies("https://example.com");
      expect(result.technologies).toBe("WordPress, Google Analytics (GA4), Google Tag Manager");
    });
  });

  describe("scripts extraction", () => {
    it("extracts external script src values", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<script src="https://example.com/app.js"></script>'));
      const result = await detectTechnologies("https://example.com");
      expect(result.scripts).toContain("https://example.com/app.js");
    });

    it("deduplicates scripts", async () => {
      const html = `
        <script src="https://example.com/app.js"></script>
        <script src="https://example.com/app.js"></script>
      `;
      vi.stubGlobal("fetch", makeMockFetch(html));
      const result = await detectTechnologies("https://example.com");
      expect(result.scripts.filter((s) => s === "https://example.com/app.js")).toHaveLength(1);
    });
  });

  describe("links extraction", () => {
    it("extracts external link href values", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.links).toContain("https://fonts.googleapis.com/css2?family=Roboto");
    });

    it("filters out favicon links", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="icon" href="https://example.com/favicon.ico">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.links).not.toContain("https://example.com/favicon.ico");
    });

    it("filters out shortcut icon links", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="shortcut icon" href="https://example.com/favicon.ico">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.links).not.toContain("https://example.com/favicon.ico");
    });

    it("filters out manifest links", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="manifest" href="https://example.com/manifest.json">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.links).not.toContain("https://example.com/manifest.json");
    });

    it("skips relative hrefs (non-http)", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<link rel="stylesheet" href="/local/style.css">'));
      const result = await detectTechnologies("https://example.com");
      expect(result.links).toEqual([]);
    });
  });

  describe("meta extraction", () => {
    it("extracts name meta tags with content", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta name="generator" content="WordPress 6.4" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.meta).toContainEqual({ name: "generator", content: "WordPress 6.4" });
    });

    it("extracts property meta tags with content", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta property="og:site_name" content="Acme Corp" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.meta).toContainEqual({ property: "og:site_name", content: "Acme Corp" });
    });

    it("extracts http-equiv meta tags with content", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta http-equiv="X-UA-Compatible" content="IE=edge" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.meta).toContainEqual({ "http-equiv": "X-UA-Compatible", content: "IE=edge" });
    });

    it("skips meta tags without content attribute", async () => {
      vi.stubGlobal("fetch", makeMockFetch('<meta name="viewport" />'));
      const result = await detectTechnologies("https://example.com");
      expect(result.meta.some((m) => m["name"] === "viewport")).toBe(false);
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
