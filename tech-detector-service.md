# Tech Detector — Microservicio en Railway

Microservicio Python que recibe una URL, descarga el HTML y devuelve las
tecnologías detectadas (CMS, ecommerce, analytics, tag managers, etc.).
Está diseñado para ser llamado desde cualquier proyecto externo, incluyendo
proyectos TypeScript.

---

## Tabla de contenidos

1. [Arquitectura](#arquitectura)
2. [Estructura de archivos](#estructura-de-archivos)
3. [Código completo de cada archivo](#código-completo-de-cada-archivo)
   - [tech_detector.py](#1-tech_detectorpy)
   - [main.py](#2-mainpy)
   - [requirements.txt](#3-requirementstxt)
   - [railway.toml](#4-railwaytoml)
   - [.gitignore](#5-gitignore)
4. [API — Contrato](#api--contrato)
5. [Cómo llamarlo desde TypeScript](#cómo-llamarlo-desde-typescript)
6. [Deploy en Railway](#deploy-en-railway)
7. [Limitaciones conocidas](#limitaciones-conocidas)

---

## Arquitectura

```
Tu proyecto TypeScript
        │
        │  POST /detect  { "url": "https://ejemplo.com" }
        ▼
┌─────────────────────────────────┐
│  FastAPI (Python)  — Railway    │
│                                 │
│  1. httpx.get(url)              │  ← request HTTP simple, sin browser
│  2. tech_detector.detect()      │  ← análisis de HTML + headers
│  3. return JSON                 │
└─────────────────────────────────┘
```

**Por qué Python y no TypeScript nativo:**
La lógica de detección (783 líneas de regex + integración con Wappalyzer) ya
existe en Python. Portarla a TypeScript tomaría días sin ventaja real.
El microservicio es un proceso separado en Railway; tu código TS lo llama por HTTP.

---

## Estructura de archivos

Crea un repositorio nuevo (puede ser un subdirectorio del monorepo o un repo
independiente) con esta estructura:

```
tech-detector/
├── tech_detector.py     ← motor de detección (no modificar)
├── main.py              ← servidor FastAPI
├── requirements.txt
├── railway.toml
└── .gitignore
```

---

## Código completo de cada archivo

### 1. `tech_detector.py`

Este es el motor de detección. Cópialo exactamente.

```python
#!/usr/bin/env python3
"""
tech_detector.py — Detección de tecnologías web desde HTML.

Combina python-Wappalyzer (CMS, frameworks, CDNs) con detección propia
de códigos de rastreo y analytics (GA, GTM, FB Pixel, HubSpot, etc.).
"""

import json
import re
import sys
from typing import Optional


# ---------------------------------------------------------------------------
# Tracking / Analytics patterns
# ---------------------------------------------------------------------------

TRACKING_PATTERNS = [
    # --- Google ---
    {
        "name": "Google Analytics (GA4)",
        "patterns": [
            re.compile(r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]G-[A-Z0-9]+['\"]", re.IGNORECASE),
            re.compile(r"googletagmanager\.com/gtag/js\?id=G-", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Google Analytics (Universal)",
        "patterns": [
            re.compile(r"google-analytics\.com/analytics\.js", re.IGNORECASE),
            re.compile(r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]UA-\d+", re.IGNORECASE),
            re.compile(r"google-analytics\.com/ga\.js", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Google Tag Manager",
        "patterns": [
            re.compile(r"googletagmanager\.com/gtm\.js\?id=GTM-", re.IGNORECASE),
            re.compile(r"googletagmanager\.com/ns\.html\?id=GTM-", re.IGNORECASE),
        ],
        "category": "tag_managers",
    },
    {
        "name": "Google Ads",
        "patterns": [
            re.compile(r"googleads\.g\.doubleclick\.net", re.IGNORECASE),
            re.compile(r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]AW-\d+", re.IGNORECASE),
            re.compile(r"google_conversion_id", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    {
        "name": "Google Optimize",
        "patterns": [
            re.compile(r"googleoptimize\.com/optimize\.js", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    # --- Facebook / Meta ---
    {
        "name": "Facebook Pixel",
        "patterns": [
            re.compile(r"connect\.facebook\.net/[a-z_]+/fbevents\.js", re.IGNORECASE),
            re.compile(r"fbq\(\s*['\"]init['\"]\s*,\s*['\"]?\d+", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Meta Conversions API",
        "patterns": [
            re.compile(r"facebook\.com/tr\?", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    # --- Microsoft ---
    {
        "name": "Microsoft Clarity",
        "patterns": [
            re.compile(r"clarity\.ms/tag/", re.IGNORECASE),
            re.compile(r"clarity\(\s*['\"]set['\"]", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Microsoft Ads (UET)",
        "patterns": [
            re.compile(r"bat\.bing\.com/bat\.js", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    # --- HubSpot ---
    {
        "name": "HubSpot",
        "patterns": [
            re.compile(r"js\.hs-scripts\.com/\d+\.js", re.IGNORECASE),
            re.compile(r"js\.hsforms\.net", re.IGNORECASE),
            re.compile(r"hs-banner\.com", re.IGNORECASE),
            re.compile(r"hbspt\.forms\.create", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    # --- Hotjar ---
    {
        "name": "Hotjar",
        "patterns": [
            re.compile(r"static\.hotjar\.com/c/hotjar-", re.IGNORECASE),
            re.compile(r"hj\(\s*['\"]init['\"]", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    # --- Chat / Support ---
    {
        "name": "Intercom",
        "patterns": [
            re.compile(r"widget\.intercom\.io/widget/", re.IGNORECASE),
            re.compile(r"Intercom\(\s*['\"]boot['\"]", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Drift",
        "patterns": [
            re.compile(r"js\.driftt\.com/include/", re.IGNORECASE),
            re.compile(r"drift\.load\(", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Zendesk",
        "patterns": [
            re.compile(r"static\.zdassets\.com/ekr/snippet\.js", re.IGNORECASE),
            re.compile(r"zE\(\s*['\"]webWidget['\"]", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Tawk.to",
        "patterns": [
            re.compile(r"embed\.tawk\.to/", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Crisp",
        "patterns": [
            re.compile(r"client\.crisp\.chat", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "LiveChat",
        "patterns": [
            re.compile(r"cdn\.livechatinc\.com/tracking\.js", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    # --- Email marketing ---
    {
        "name": "Mailchimp",
        "patterns": [
            re.compile(r"chimpstatic\.com/mcjs", re.IGNORECASE),
            re.compile(r"list-manage\.com/subscribe", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Klaviyo",
        "patterns": [
            re.compile(r"static\.klaviyo\.com/onsite/js/", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "ActiveCampaign",
        "patterns": [
            re.compile(r"trackcmp\.net/", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    # --- Analytics avanzados ---
    {
        "name": "Mixpanel",
        "patterns": [
            re.compile(r"cdn\.mxpnl\.com/libs/mixpanel", re.IGNORECASE),
            re.compile(r"mixpanel\.init\(", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Segment",
        "patterns": [
            re.compile(r"cdn\.segment\.com/analytics\.js", re.IGNORECASE),
            re.compile(r"analytics\.load\(\s*['\"]", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Amplitude",
        "patterns": [
            re.compile(r"cdn\.amplitude\.com/libs/", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Heap",
        "patterns": [
            re.compile(r"cdn\.heapanalytics\.com/js/heap-", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Plausible",
        "patterns": [
            re.compile(r"plausible\.io/js/", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "Matomo",
        "patterns": [
            re.compile(r"matomo\.js", re.IGNORECASE),
            re.compile(r"piwik\.js", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    # --- CRM / Sales ---
    {
        "name": "Salesforce",
        "patterns": [
            re.compile(r"force\.com/", re.IGNORECASE),
            re.compile(r"salesforceliveagent\.com", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    {
        "name": "Pardot",
        "patterns": [
            re.compile(r"pi\.pardot\.com/pd\.js", re.IGNORECASE),
            re.compile(r"go\.pardot\.com", re.IGNORECASE),
        ],
        "category": "marketing",
    },
    # --- A/B testing ---
    {
        "name": "Optimizely",
        "patterns": [
            re.compile(r"cdn\.optimizely\.com/js/", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    {
        "name": "VWO",
        "patterns": [
            re.compile(r"dev\.visualwebsiteoptimizer\.com/", re.IGNORECASE),
        ],
        "category": "analytics",
    },
    # --- Payments ---
    {
        "name": "Stripe",
        "patterns": [
            re.compile(r"js\.stripe\.com/v\d+", re.IGNORECASE),
        ],
        "category": "payments",
    },
    {
        "name": "PayPal",
        "patterns": [
            re.compile(r"paypal\.com/sdk/js", re.IGNORECASE),
            re.compile(r"paypalobjects\.com", re.IGNORECASE),
        ],
        "category": "payments",
    },
    {
        "name": "MercadoPago",
        "patterns": [
            re.compile(r"sdk\.mercadopago\.com", re.IGNORECASE),
            re.compile(r"mercadopago\.com\.mx", re.IGNORECASE),
        ],
        "category": "payments",
    },
    # --- Advertising ---
    {
        "name": "Twitter/X Pixel",
        "patterns": [
            re.compile(r"static\.ads-twitter\.com/uwt\.js", re.IGNORECASE),
            re.compile(r"platform\.twitter\.com/widgets\.js", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    {
        "name": "LinkedIn Insight Tag",
        "patterns": [
            re.compile(r"snap\.licdn\.com/li\.lms-analytics", re.IGNORECASE),
            re.compile(r"_linkedin_partner_id", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    {
        "name": "TikTok Pixel",
        "patterns": [
            re.compile(r"analytics\.tiktok\.com/i18n/pixel", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    {
        "name": "Pinterest Tag",
        "patterns": [
            re.compile(r"s\.pinimg\.com/ct/core\.js", re.IGNORECASE),
            re.compile(r"pintrk\(\s*['\"]load['\"]", re.IGNORECASE),
        ],
        "category": "advertising",
    },
    # --- SEO ---
    {
        "name": "Yoast SEO",
        "patterns": [
            re.compile(r"yoast-schema-graph", re.IGNORECASE),
            re.compile(r"yoast\.com/wordpress/plugins/seo", re.IGNORECASE),
        ],
        "category": "seo",
    },
    {
        "name": "RankMath",
        "patterns": [
            re.compile(r"rank-math", re.IGNORECASE),
        ],
        "category": "seo",
    },
    # --- CDN ---
    {
        "name": "Cloudflare",
        "patterns": [
            re.compile(r"cdnjs\.cloudflare\.com", re.IGNORECASE),
            re.compile(r"cf-ray", re.IGNORECASE),
            re.compile(r"__cf_bm", re.IGNORECASE),
        ],
        "category": "cdn",
    },
    {
        "name": "jsDelivr",
        "patterns": [
            re.compile(r"cdn\.jsdelivr\.net", re.IGNORECASE),
        ],
        "category": "cdn",
    },
    {
        "name": "unpkg",
        "patterns": [
            re.compile(r"unpkg\.com/", re.IGNORECASE),
        ],
        "category": "cdn",
    },
    # --- Cookie consent ---
    {
        "name": "CookieBot",
        "patterns": [
            re.compile(r"consent\.cookiebot\.com", re.IGNORECASE),
        ],
        "category": "privacy",
    },
    {
        "name": "OneTrust",
        "patterns": [
            re.compile(r"cdn\.cookielaw\.org", re.IGNORECASE),
            re.compile(r"onetrust\.com", re.IGNORECASE),
        ],
        "category": "privacy",
    },
]


# ---------------------------------------------------------------------------
# CMS detection
# ---------------------------------------------------------------------------

CMS_PATTERNS = [
    {
        "name": "WordPress",
        "patterns": [
            re.compile(r"/wp-content/", re.IGNORECASE),
            re.compile(r"/wp-includes/", re.IGNORECASE),
            re.compile(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']WordPress\s*([\d.]*)', re.IGNORECASE),
        ],
        "version_pattern": re.compile(r'content=["\']WordPress\s+([\d.]+)', re.IGNORECASE),
    },
    {
        "name": "Shopify",
        "patterns": [
            re.compile(r"cdn\.shopify\.com", re.IGNORECASE),
            re.compile(r"Shopify\.theme", re.IGNORECASE),
            re.compile(r"myshopify\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "Wix",
        "patterns": [
            re.compile(r"static\.wixstatic\.com", re.IGNORECASE),
            re.compile(r"wix\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "Squarespace",
        "patterns": [
            re.compile(r"static\d*\.squarespace\.com", re.IGNORECASE),
            re.compile(r"sqsp\.net", re.IGNORECASE),
        ],
    },
    {
        "name": "Webflow",
        "patterns": [
            re.compile(r"assets\.website-files\.com", re.IGNORECASE),
            re.compile(r"assets-global\.website-files\.com", re.IGNORECASE),
            re.compile(r'data-wf-site=', re.IGNORECASE),
        ],
    },
    {
        "name": "Joomla",
        "patterns": [
            re.compile(r"/media/jui/", re.IGNORECASE),
            re.compile(r'<meta[^>]+content=["\']Joomla', re.IGNORECASE),
        ],
    },
    {
        "name": "Drupal",
        "patterns": [
            re.compile(r"drupal\.js", re.IGNORECASE),
            re.compile(r"/sites/default/files", re.IGNORECASE),
            re.compile(r'<meta[^>]+content=["\']Drupal', re.IGNORECASE),
        ],
    },
    {
        "name": "PrestaShop",
        "patterns": [
            re.compile(r"/modules/prestashop", re.IGNORECASE),
            re.compile(r'<meta[^>]+content=["\']PrestaShop', re.IGNORECASE),
            re.compile(r"prestashop", re.IGNORECASE),
        ],
    },
    {
        "name": "Magento",
        "patterns": [
            re.compile(r"/static/frontend/Magento", re.IGNORECASE),
            re.compile(r"mage/cookies", re.IGNORECASE),
        ],
    },
    {
        "name": "GoDaddy Website Builder",
        "patterns": [
            re.compile(r"godaddy\.com/website-builder", re.IGNORECASE),
            re.compile(r"img\d+\.wsimg\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "HubSpot CMS",
        "patterns": [
            re.compile(r'<meta[^>]+content=["\']HubSpot', re.IGNORECASE),
            re.compile(r"hs-sites\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "Weebly",
        "patterns": [
            re.compile(r"cdn\d*\.editmysite\.com", re.IGNORECASE),
            re.compile(r"weebly\.com", re.IGNORECASE),
        ],
    },
]

ECOMMERCE_PATTERNS = [
    {
        "name": "WooCommerce",
        "patterns": [
            re.compile(r"woocommerce", re.IGNORECASE),
            re.compile(r"wc-add-to-cart", re.IGNORECASE),
        ],
    },
    {
        "name": "Shopify",
        "patterns": [
            re.compile(r"cdn\.shopify\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "Tiendanube",
        "patterns": [
            re.compile(r"tiendanube\.com", re.IGNORECASE),
            re.compile(r"nuvemshop\.com", re.IGNORECASE),
        ],
    },
    {
        "name": "VTEX",
        "patterns": [
            re.compile(r"vtex\.com", re.IGNORECASE),
            re.compile(r"vteximg\.com", re.IGNORECASE),
        ],
    },
]


# ---------------------------------------------------------------------------
# Wappalyzer integration (opcional — mejora detección de frameworks)
# ---------------------------------------------------------------------------

def _detect_with_wappalyzer(html: str, url: str, headers: dict = None) -> dict:
    try:
        from Wappalyzer import Wappalyzer, WebPage
        wappalyzer = Wappalyzer.latest()
        webpage = WebPage(url=url, html=html, headers=headers or {})
        return wappalyzer.analyze_with_versions_and_categories(webpage)
    except ImportError:
        return {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Core detection
# ---------------------------------------------------------------------------

def _match_patterns(html: str, patterns_list: list) -> list:
    found = []
    for item in patterns_list:
        for pattern in item["patterns"]:
            if pattern.search(html):
                name = item["name"]
                version_pat = item.get("version_pattern")
                if version_pat:
                    vmatch = version_pat.search(html)
                    if vmatch:
                        name = f"{item['name']} {vmatch.group(1)}"
                found.append(name)
                break
    return found


def detect_technology(html: str, url: str = "", headers: dict = None) -> dict:
    """
    Detecta tecnologías web desde HTML crudo.

    Args:
        html:    Contenido HTML del sitio
        url:     URL del sitio (mejora detección de Wappalyzer)
        headers: Headers HTTP de la respuesta (opcionales)

    Returns:
        dict con las siguientes claves:
            cms, ecommerce, analytics, tag_managers, frameworks,
            marketing, advertising, payments, cdn, seo, privacy,
            otros, resumen
    """
    if not html:
        return {
            "resumen": "", "cms": "", "analytics": [], "tag_managers": [],
            "frameworks": [], "ecommerce": "", "marketing": [],
            "advertising": [], "payments": [], "cdn": [],
            "seo": [], "privacy": [], "otros": [],
        }

    cms_found = _match_patterns(html, CMS_PATTERNS)
    cms = cms_found[0] if cms_found else ""

    ecommerce_found = _match_patterns(html, ECOMMERCE_PATTERNS)
    ecommerce = ecommerce_found[0] if ecommerce_found else ""

    tracking_by_category: dict = {}
    for item in TRACKING_PATTERNS:
        for pattern in item["patterns"]:
            if pattern.search(html):
                cat = item["category"]
                if cat not in tracking_by_category:
                    tracking_by_category[cat] = []
                tracking_by_category[cat].append(item["name"])
                break

    wap_results = _detect_with_wappalyzer(html, url or "https://example.com", headers)

    frameworks = []
    wap_extra = []
    our_names = {item["name"] for item in TRACKING_PATTERNS}
    our_names.update(item["name"] for item in CMS_PATTERNS)
    our_names.update(item["name"] for item in ECOMMERCE_PATTERNS)

    for tech_name, info in wap_results.items():
        categories = info.get("categories", [])
        versions = info.get("versions", [])
        display_name = f"{tech_name} {versions[0]}" if versions else tech_name

        is_framework = any(c in categories for c in [
            "JavaScript frameworks", "JavaScript libraries",
            "UI frameworks", "Web frameworks",
        ])
        is_cms = any(c in categories for c in ["CMS", "Blogs"])
        is_ecommerce = any(c in categories for c in ["Ecommerce"])

        if is_framework:
            frameworks.append(display_name)
        elif is_cms and not cms:
            cms = display_name
        elif is_ecommerce and not ecommerce:
            ecommerce = display_name
        elif not is_cms and not is_ecommerce and tech_name not in our_names:
            wap_extra.append(display_name)

    result = {
        "cms": cms,
        "analytics": tracking_by_category.get("analytics", []),
        "tag_managers": tracking_by_category.get("tag_managers", []),
        "frameworks": frameworks,
        "ecommerce": ecommerce,
        "marketing": tracking_by_category.get("marketing", []),
        "advertising": tracking_by_category.get("advertising", []),
        "payments": tracking_by_category.get("payments", []),
        "cdn": tracking_by_category.get("cdn", []),
        "seo": tracking_by_category.get("seo", []),
        "privacy": tracking_by_category.get("privacy", []),
        "otros": wap_extra,
    }

    parts = []
    if cms:
        parts.append(cms)
    if ecommerce and ecommerce not in (cms or ""):
        parts.append(ecommerce)
    if result["analytics"]:
        parts.append(", ".join(result["analytics"]))
    if result["tag_managers"]:
        parts.append(", ".join(result["tag_managers"]))
    if result["marketing"]:
        parts.append(", ".join(result["marketing"]))
    if result["advertising"]:
        parts.append(", ".join(result["advertising"]))
    if frameworks:
        parts.append(", ".join(frameworks[:5]))
    if result["payments"]:
        parts.append(", ".join(result["payments"]))

    result["resumen"] = " | ".join(parts) if parts else "No detectado"
    return result
```

---

### 2. `main.py`

El servidor FastAPI. Este es el único archivo que necesitas escribir.

```python
import os
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl

from tech_detector import detect_technology

app = FastAPI(title="Tech Detector", version="1.0.0")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
}


class DetectRequest(BaseModel):
    url: HttpUrl


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/detect")
def detect(req: DetectRequest):
    url = str(req.url)
    try:
        with httpx.Client(
            timeout=15,
            follow_redirects=True,
            verify=False,
            headers=HEADERS,
        ) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout al descargar la URL")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"HTTP {e.response.status_code} desde la URL")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:200])

    result = detect_technology(
        html=resp.text,
        url=url,
        headers=dict(resp.headers),
    )
    return result
```

---

### 3. `requirements.txt`

```
fastapi==0.111.0
uvicorn[standard]==0.29.0
httpx==0.27.0
python-Wappalyzer==0.3.1
pydantic==2.7.1
```

> **Nota sobre Wappalyzer:** es opcional. Si quieres quitar la dependencia,
> borra la línea y la función `_detect_with_wappalyzer` en `tech_detector.py`
> seguirá retornando `{}` sin error (tiene el `ImportError` atrapado).
> Sin Wappalyzer pierdes la detección de frameworks JS (React, Vue, jQuery,
> Bootstrap, etc.) pero el resto funciona igual.

---

### 4. `railway.toml`

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "uvicorn main:app --host 0.0.0.0 --port $PORT"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

---

### 5. `.gitignore`

```
__pycache__/
*.pyc
.env
venv/
.venv/
```

---

## API — Contrato

### `POST /detect`

**Request body (JSON):**

```json
{
  "url": "https://ejemplo.com"
}
```

**Response 200 (JSON):**

```json
{
  "cms":          "WordPress 6.4",
  "ecommerce":    "WooCommerce",
  "analytics":    ["Google Analytics (GA4)", "Facebook Pixel"],
  "tag_managers": ["Google Tag Manager"],
  "frameworks":   ["jQuery 3.7", "Bootstrap 5.3"],
  "marketing":    ["HubSpot", "Mailchimp"],
  "advertising":  ["Google Ads", "LinkedIn Insight Tag"],
  "payments":     ["Stripe"],
  "cdn":          ["Cloudflare"],
  "seo":          ["Yoast SEO"],
  "privacy":      [],
  "otros":        [],
  "resumen":      "WordPress 6.4 | WooCommerce | GA4, FB Pixel | GTM | HubSpot"
}
```

**Campos del response:**

| Campo          | Tipo            | Descripción                                      |
|----------------|-----------------|--------------------------------------------------|
| `cms`          | `string`        | CMS detectado. Vacío si no hay.                  |
| `ecommerce`    | `string`        | Plataforma e-commerce. Vacío si no hay.          |
| `analytics`    | `string[]`      | Herramientas de analítica (GA4, FB Pixel, etc.)  |
| `tag_managers` | `string[]`      | GTM u otros tag managers                         |
| `frameworks`   | `string[]`      | Frameworks JS (React, Vue, jQuery…)              |
| `marketing`    | `string[]`      | CRM, chat, email marketing (HubSpot, Intercom…)  |
| `advertising`  | `string[]`      | Píxeles de ads (Google Ads, LinkedIn, TikTok…)   |
| `payments`     | `string[]`      | Pasarelas de pago (Stripe, PayPal, MercadoPago)  |
| `cdn`          | `string[]`      | CDN detectado                                    |
| `seo`          | `string[]`      | Plugins SEO (Yoast, RankMath)                    |
| `privacy`      | `string[]`      | Cookie consent (OneTrust, CookieBot)             |
| `otros`        | `string[]`      | Tecnologías adicionales detectadas por Wappalyzer|
| `resumen`      | `string`        | Cadena legible con lo más relevante              |

**Errores:**

| Código | Motivo                                   |
|--------|------------------------------------------|
| `422`  | URL inválida o faltante en el body       |
| `502`  | Error HTTP al descargar la URL           |
| `504`  | Timeout (la URL tardó más de 15 segundos)|

### `GET /health`

Retorna `{"status": "ok"}`. Usar como health check en Railway.

---

## Cómo llamarlo desde TypeScript

### Con `fetch` nativo

```typescript
interface TechResult {
  cms: string;
  ecommerce: string;
  analytics: string[];
  tag_managers: string[];
  frameworks: string[];
  marketing: string[];
  advertising: string[];
  payments: string[];
  cdn: string[];
  seo: string[];
  privacy: string[];
  otros: string[];
  resumen: string;
}

async function detectTech(url: string): Promise<TechResult> {
  const response = await fetch(process.env.TECH_DETECTOR_URL + "/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Tech detector error ${response.status}: ${error.detail ?? ""}`);
  }

  return response.json() as Promise<TechResult>;
}

// Uso:
const tech = await detectTech("https://ejemplo.com");
console.log(tech.resumen);   // "WordPress 6.4 | WooCommerce | GA4 | GTM"
console.log(tech.cms);       // "WordPress 6.4"
console.log(tech.analytics); // ["Google Analytics (GA4)", "Facebook Pixel"]
```

### Variable de entorno recomendada

En tu proyecto TypeScript, agrega en `.env`:

```
TECH_DETECTOR_URL=https://tu-servicio.up.railway.app
```

---

## Deploy en Railway

### Pasos

1. **Crear el repositorio** con los 5 archivos descritos arriba.

2. **Ir a [railway.app](https://railway.app)** → New Project → Deploy from GitHub
   → seleccionar el repo.

3. Railway detecta automáticamente Python via Nixpacks y usa el
   `startCommand` del `railway.toml`.

4. Una vez desplegado, copiar la URL pública del servicio
   (ej: `https://tech-detector-production.up.railway.app`).

5. Agregar esa URL como variable de entorno `TECH_DETECTOR_URL` en tu
   proyecto TypeScript.

### Variables de entorno en Railway

El servicio no requiere variables de entorno propias. Solo necesita acceso
saliente a internet (para descargar las URLs que le mandes).

### Costo estimado

Railway Hobby Plan (~$5/mes) es suficiente. El servicio es stateless y
liviano: cada request tarda ~1-3 segundos, usa ~100MB RAM.

---

## Limitaciones conocidas

### Sitios que bloquean requests HTTP simples

El servicio usa `httpx` (HTTP puro, sin browser). Sitios con Cloudflare
challenge, bot detection agresivo o que requieren JavaScript para renderizar
el contenido importante pueden devolver HTML vacío o una página de bloqueo.

**Impacto estimado:** ~10-20% de sitios en contextos de PyMEs. Para estos
casos el `resumen` será `"No detectado"` en lugar de un error.

**Solución futura si se necesita:** reemplazar el `httpx.get` en `main.py`
por una llamada a Playwright (headless browser). El resto del código no cambia.

### Wappalyzer y su base de datos

`python-Wappalyzer` descarga la base de datos de tecnologías al primer uso
(puede tardar unos segundos en el cold start). En deployments sucesivos usa
el caché. Si Wappalyzer falla o no está instalado, el servicio sigue
funcionando con los patrones propios (CMS, ecommerce, tracking, analytics).

### Timeouts

El timeout es de 15 segundos. Sitios muy lentos o caídos retornan HTTP 504.
Ajustar el valor en `main.py` si se necesita más tolerancia.
