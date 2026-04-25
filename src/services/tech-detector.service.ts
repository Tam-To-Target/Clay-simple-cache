import { TechResult } from "../types";

interface TrackingPattern {
  name: string;
  patterns: RegExp[];
  category: string;
}

interface CmsPattern {
  name: string;
  patterns: RegExp[];
  versionPattern?: RegExp;
}

interface EcommercePattern {
  name: string;
  patterns: RegExp[];
}

const TRACKING_PATTERNS: TrackingPattern[] = [
  {
    name: "Google Analytics (GA4)",
    patterns: [
      new RegExp(`gtag\\(\\s*['"]config['"]\\s*,\\s*['"]G-[A-Z0-9]+['"]`, "i"),
      new RegExp(`googletagmanager\\.com/gtag/js\\?id=G-`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Google Analytics (Universal)",
    patterns: [
      new RegExp(`google-analytics\\.com/analytics\\.js`, "i"),
      new RegExp(`gtag\\(\\s*['"]config['"]\\s*,\\s*['"]UA-\\d+`, "i"),
      new RegExp(`google-analytics\\.com/ga\\.js`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Google Tag Manager",
    patterns: [
      new RegExp(`googletagmanager\\.com/gtm\\.js\\?id=GTM-`, "i"),
      new RegExp(`googletagmanager\\.com/ns\\.html\\?id=GTM-`, "i"),
    ],
    category: "tag_managers",
  },
  {
    name: "Google Ads",
    patterns: [
      new RegExp(`googleads\\.g\\.doubleclick\\.net`, "i"),
      new RegExp(`gtag\\(\\s*['"]config['"]\\s*,\\s*['"]AW-\\d+`, "i"),
      new RegExp(`google_conversion_id`, "i"),
    ],
    category: "advertising",
  },
  {
    name: "Google Optimize",
    patterns: [new RegExp(`googleoptimize\\.com/optimize\\.js`, "i")],
    category: "analytics",
  },
  {
    name: "Facebook Pixel",
    patterns: [
      new RegExp(`connect\\.facebook\\.net/[a-z_]+/fbevents\\.js`, "i"),
      new RegExp(`fbq\\(\\s*['"]init['"]\\s*,\\s*['"]?\\d+`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Meta Conversions API",
    patterns: [new RegExp(`facebook\\.com/tr\\?`, "i")],
    category: "analytics",
  },
  {
    name: "Microsoft Clarity",
    patterns: [
      new RegExp(`clarity\\.ms/tag/`, "i"),
      new RegExp(`clarity\\(\\s*['"]set['"]`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Microsoft Ads (UET)",
    patterns: [new RegExp(`bat\\.bing\\.com/bat\\.js`, "i")],
    category: "advertising",
  },
  {
    name: "HubSpot",
    patterns: [
      new RegExp(`js\\.hs-scripts\\.com/\\d+\\.js`, "i"),
      new RegExp(`js\\.hsforms\\.net`, "i"),
      new RegExp(`hs-banner\\.com`, "i"),
      new RegExp(`hbspt\\.forms\\.create`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Hotjar",
    patterns: [
      new RegExp(`static\\.hotjar\\.com/c/hotjar-`, "i"),
      new RegExp(`hj\\(\\s*['"]init['"]`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Intercom",
    patterns: [
      new RegExp(`widget\\.intercom\\.io/widget/`, "i"),
      new RegExp(`Intercom\\(\\s*['"]boot['"]`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Drift",
    patterns: [
      new RegExp(`js\\.driftt\\.com/include/`, "i"),
      new RegExp(`drift\\.load\\(`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Zendesk",
    patterns: [
      new RegExp(`static\\.zdassets\\.com/ekr/snippet\\.js`, "i"),
      new RegExp(`zE\\(\\s*['"]webWidget['"]`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Tawk.to",
    patterns: [new RegExp(`embed\\.tawk\\.to/`, "i")],
    category: "marketing",
  },
  {
    name: "Crisp",
    patterns: [new RegExp(`client\\.crisp\\.chat`, "i")],
    category: "marketing",
  },
  {
    name: "LiveChat",
    patterns: [new RegExp(`cdn\\.livechatinc\\.com/tracking\\.js`, "i")],
    category: "marketing",
  },
  {
    name: "Mailchimp",
    patterns: [
      new RegExp(`chimpstatic\\.com/mcjs`, "i"),
      new RegExp(`list-manage\\.com/subscribe`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Klaviyo",
    patterns: [new RegExp(`static\\.klaviyo\\.com/onsite/js/`, "i")],
    category: "marketing",
  },
  {
    name: "ActiveCampaign",
    patterns: [new RegExp(`trackcmp\\.net/`, "i")],
    category: "marketing",
  },
  {
    name: "Mixpanel",
    patterns: [
      new RegExp(`cdn\\.mxpnl\\.com/libs/mixpanel`, "i"),
      new RegExp(`mixpanel\\.init\\(`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Segment",
    patterns: [
      new RegExp(`cdn\\.segment\\.com/analytics\\.js`, "i"),
      new RegExp(`analytics\\.load\\(\\s*['"]`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Amplitude",
    patterns: [new RegExp(`cdn\\.amplitude\\.com/libs/`, "i")],
    category: "analytics",
  },
  {
    name: "Heap",
    patterns: [new RegExp(`cdn\\.heapanalytics\\.com/js/heap-`, "i")],
    category: "analytics",
  },
  {
    name: "Plausible",
    patterns: [new RegExp(`plausible\\.io/js/`, "i")],
    category: "analytics",
  },
  {
    name: "Matomo",
    patterns: [
      new RegExp(`matomo\\.js`, "i"),
      new RegExp(`piwik\\.js`, "i"),
    ],
    category: "analytics",
  },
  {
    name: "Salesforce",
    patterns: [
      new RegExp(`force\\.com/`, "i"),
      new RegExp(`salesforceliveagent\\.com`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Pardot",
    patterns: [
      new RegExp(`pi\\.pardot\\.com/pd\\.js`, "i"),
      new RegExp(`go\\.pardot\\.com`, "i"),
    ],
    category: "marketing",
  },
  {
    name: "Optimizely",
    patterns: [new RegExp(`cdn\\.optimizely\\.com/js/`, "i")],
    category: "analytics",
  },
  {
    name: "VWO",
    patterns: [new RegExp(`dev\\.visualwebsiteoptimizer\\.com/`, "i")],
    category: "analytics",
  },
  {
    name: "Stripe",
    patterns: [new RegExp(`js\\.stripe\\.com/v\\d+`, "i")],
    category: "payments",
  },
  {
    name: "PayPal",
    patterns: [
      new RegExp(`paypal\\.com/sdk/js`, "i"),
      new RegExp(`paypalobjects\\.com`, "i"),
    ],
    category: "payments",
  },
  {
    name: "MercadoPago",
    patterns: [
      new RegExp(`sdk\\.mercadopago\\.com`, "i"),
      new RegExp(`mercadopago\\.com\\.mx`, "i"),
    ],
    category: "payments",
  },
  {
    name: "Twitter/X Pixel",
    patterns: [
      new RegExp(`static\\.ads-twitter\\.com/uwt\\.js`, "i"),
      new RegExp(`platform\\.twitter\\.com/widgets\\.js`, "i"),
    ],
    category: "advertising",
  },
  {
    name: "LinkedIn Insight Tag",
    patterns: [
      new RegExp(`snap\\.licdn\\.com/li\\.lms-analytics`, "i"),
      new RegExp(`_linkedin_partner_id`, "i"),
    ],
    category: "advertising",
  },
  {
    name: "TikTok Pixel",
    patterns: [new RegExp(`analytics\\.tiktok\\.com/i18n/pixel`, "i")],
    category: "advertising",
  },
  {
    name: "Pinterest Tag",
    patterns: [
      new RegExp(`s\\.pinimg\\.com/ct/core\\.js`, "i"),
      new RegExp(`pintrk\\(\\s*['"]load['"]`, "i"),
    ],
    category: "advertising",
  },
  {
    name: "Yoast SEO",
    patterns: [
      new RegExp(`yoast-schema-graph`, "i"),
      new RegExp(`yoast\\.com/wordpress/plugins/seo`, "i"),
    ],
    category: "seo",
  },
  {
    name: "RankMath",
    patterns: [new RegExp(`rank-math`, "i")],
    category: "seo",
  },
  {
    name: "Cloudflare",
    patterns: [
      new RegExp(`cdnjs\\.cloudflare\\.com`, "i"),
      new RegExp(`cf-ray`, "i"),
      new RegExp(`__cf_bm`, "i"),
    ],
    category: "cdn",
  },
  {
    name: "jsDelivr",
    patterns: [new RegExp(`cdn\\.jsdelivr\\.net`, "i")],
    category: "cdn",
  },
  {
    name: "unpkg",
    patterns: [new RegExp(`unpkg\\.com/`, "i")],
    category: "cdn",
  },
  {
    name: "CookieBot",
    patterns: [new RegExp(`consent\\.cookiebot\\.com`, "i")],
    category: "privacy",
  },
  {
    name: "OneTrust",
    patterns: [
      new RegExp(`cdn\\.cookielaw\\.org`, "i"),
      new RegExp(`onetrust\\.com`, "i"),
    ],
    category: "privacy",
  },
];

const CMS_PATTERNS: CmsPattern[] = [
  {
    name: "WordPress",
    patterns: [
      new RegExp(`/wp-content/`, "i"),
      new RegExp(`/wp-includes/`, "i"),
      new RegExp(`<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\\s*([\\d.]*)`, "i"),
    ],
    versionPattern: new RegExp(`content=["']WordPress\\s+([\\d.]+)`, "i"),
  },
  {
    name: "Shopify",
    patterns: [
      new RegExp(`cdn\\.shopify\\.com`, "i"),
      new RegExp(`Shopify\\.theme`, "i"),
      new RegExp(`myshopify\\.com`, "i"),
    ],
  },
  {
    name: "Wix",
    patterns: [
      new RegExp(`static\\.wixstatic\\.com`, "i"),
      new RegExp(`wix\\.com`, "i"),
    ],
  },
  {
    name: "Squarespace",
    patterns: [
      new RegExp(`static\\d*\\.squarespace\\.com`, "i"),
      new RegExp(`sqsp\\.net`, "i"),
    ],
  },
  {
    name: "Webflow",
    patterns: [
      new RegExp(`assets\\.website-files\\.com`, "i"),
      new RegExp(`assets-global\\.website-files\\.com`, "i"),
      new RegExp(`data-wf-site=`, "i"),
    ],
  },
  {
    name: "Joomla",
    patterns: [
      new RegExp(`/media/jui/`, "i"),
      new RegExp(`<meta[^>]+content=["']Joomla`, "i"),
    ],
  },
  {
    name: "Drupal",
    patterns: [
      new RegExp(`drupal\\.js`, "i"),
      new RegExp(`/sites/default/files`, "i"),
      new RegExp(`<meta[^>]+content=["']Drupal`, "i"),
    ],
  },
  {
    name: "PrestaShop",
    patterns: [
      new RegExp(`/modules/prestashop`, "i"),
      new RegExp(`<meta[^>]+content=["']PrestaShop`, "i"),
      new RegExp(`prestashop`, "i"),
    ],
  },
  {
    name: "Magento",
    patterns: [
      new RegExp(`/static/frontend/Magento`, "i"),
      new RegExp(`mage/cookies`, "i"),
    ],
  },
  {
    name: "GoDaddy Website Builder",
    patterns: [
      new RegExp(`godaddy\\.com/website-builder`, "i"),
      new RegExp(`img\\d+\\.wsimg\\.com`, "i"),
    ],
  },
  {
    name: "HubSpot CMS",
    patterns: [
      new RegExp(`<meta[^>]+content=["']HubSpot`, "i"),
      new RegExp(`hs-sites\\.com`, "i"),
    ],
  },
  {
    name: "Weebly",
    patterns: [
      new RegExp(`cdn\\d*\\.editmysite\\.com`, "i"),
      new RegExp(`weebly\\.com`, "i"),
    ],
  },
];

const ECOMMERCE_PATTERNS: EcommercePattern[] = [
  {
    name: "WooCommerce",
    patterns: [
      new RegExp(`woocommerce`, "i"),
      new RegExp(`wc-add-to-cart`, "i"),
    ],
  },
  {
    name: "Shopify",
    patterns: [new RegExp(`cdn\\.shopify\\.com`, "i")],
  },
  {
    name: "Tiendanube",
    patterns: [
      new RegExp(`tiendanube\\.com`, "i"),
      new RegExp(`nuvemshop\\.com`, "i"),
    ],
  },
  {
    name: "VTEX",
    patterns: [
      new RegExp(`vtex\\.com`, "i"),
      new RegExp(`vteximg\\.com`, "i"),
    ],
  },
];

function extractScripts(html: string): string[] {
  const results: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim();
    if (src) results.push(src);
  }
  return [...new Set(results)];
}

function extractLinks(html: string): string[] {
  const results: string[] = [];
  const re = /<link[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const full = m[0];
    // skip rel="shortcut icon", rel="icon", rel="manifest", rel="canonical", rel="alternate"
    if (/rel=["'](shortcut icon|icon|manifest|canonical|alternate)["']/i.test(full)) continue;
    const href = m[1].trim();
    if (href && href.startsWith('http')) results.push(href);
  }
  return [...new Set(results)];
}

function extractMeta(html: string): Record<string, string>[] {
  const results: Record<string, string>[] = [];
  const re = /<meta\s([^>]+)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const contentMatch = /content=["']([^"']*)["']/i.exec(attrs);
    if (!contentMatch) continue;
    const content = contentMatch[1].trim();
    if (!content) continue;

    const nameMatch = /(?:^|\s)name=["']([^"']+)["']/i.exec(attrs);
    const propMatch = /property=["']([^"']+)["']/i.exec(attrs);
    const httpMatch = /http-equiv=["']([^"']+)["']/i.exec(attrs);

    if (nameMatch) results.push({ name: nameMatch[1], content });
    else if (propMatch) results.push({ property: propMatch[1], content });
    else if (httpMatch) results.push({ 'http-equiv': httpMatch[1], content });
  }
  return results;
}

export async function detectTechnologies(url: string): Promise<TechResult> {
  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("URL inválida");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} desde la URL`);
    }

    html = await response.text();
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error("Timeout al obtener la URL");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  // Detect CMS
  let cms = "";
  for (const cmsDef of CMS_PATTERNS) {
    const matched = cmsDef.patterns.some((p) => p.test(html));
    if (matched) {
      cms = cmsDef.name;
      if (cmsDef.versionPattern) {
        const versionMatch = html.match(cmsDef.versionPattern);
        if (versionMatch?.[1]) {
          cms = `${cmsDef.name} ${versionMatch[1]}`;
        }
      }
      break;
    }
  }

  // Detect ecommerce
  let ecommerce = "";
  for (const ecDef of ECOMMERCE_PATTERNS) {
    const matched = ecDef.patterns.some((p) => p.test(html));
    if (matched) {
      ecommerce = ecDef.name;
      break;
    }
  }

  // Detect tracking technologies grouped by category
  const grouped: Record<string, string[]> = {
    analytics: [],
    tag_managers: [],
    advertising: [],
    marketing: [],
    payments: [],
    cdn: [],
    seo: [],
    privacy: [],
    otros: [],
  };

  for (const trackDef of TRACKING_PATTERNS) {
    const matched = trackDef.patterns.some((p) => p.test(html));
    if (matched) {
      const cat = trackDef.category as string;
      if (cat in grouped) {
        grouped[cat].push(trackDef.name);
      } else {
        grouped["otros"].push(trackDef.name);
      }
    }
  }

  // Build flat technologies string
  const parts: string[] = [];
  if (cms) parts.push(cms);
  if (ecommerce) parts.push(ecommerce);
  for (const cat of [
    "analytics",
    "tag_managers",
    "advertising",
    "marketing",
    "payments",
    "cdn",
    "seo",
    "privacy",
    "otros",
  ]) {
    parts.push(...grouped[cat]);
  }
  const technologies = parts.join(", ");

  return {
    technologies,
    scripts: extractScripts(html),
    links: extractLinks(html),
    meta: extractMeta(html),
  };
}
