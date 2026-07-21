import { Request, Response } from 'express';
import { apiDocumentation } from '../docs/content';

export const docsController = {
  async get(req: Request, res: Response): Promise<void> {
    const baseUrl = req.protocol + '://' + req.get('host');
    const safeContent = apiDocumentation
      .replace('{{BASE_URL}}', baseUrl)
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Identity Cache API Docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-light.min.css" />
  <style>
    body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
    #toc { border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 20px; margin-bottom: 32px; background: #f6f8fa; }
    #toc strong { display: block; margin-bottom: 8px; }
    #toc ul { list-style: none; padding-left: 0; margin: 0; columns: 2; -webkit-columns: 2; }
    #toc li { margin: 2px 0; break-inside: avoid; }
    #toc li.toc-h3 { padding-left: 16px; font-size: 0.9em; }
    #toc a { text-decoration: none; }
    #toc a:hover { text-decoration: underline; }
    :target { scroll-margin-top: 16px; }
  </style>
</head>
<body class="markdown-body">
  <nav id="toc"></nav>
  <div id="content"></div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    const markdownContent = \`${safeContent}\`;
    const content = document.getElementById('content');
    content.innerHTML = marked.parse(markdownContent);
    // Build a navigable index: slug every heading, link the h2/h3 sections.
    (function () {
      var used = {};
      var items = [];
      content.querySelectorAll('h1, h2, h3').forEach(function (h) {
        var slug = h.textContent.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) slug = 'section';
        if (used[slug] != null) { used[slug]++; slug = slug + '-' + used[slug]; } else { used[slug] = 0; }
        h.id = slug;
        if (h.tagName === 'H2' || h.tagName === 'H3') {
          items.push({ lvl: h.tagName.toLowerCase(), slug: slug, text: h.textContent });
        }
      });
      var out = '<strong>Contents</strong><ul>';
      items.forEach(function (i) {
        out += '<li class="toc-' + i.lvl + '"><a href="#' + i.slug + '">' + i.text + '</a></li>';
      });
      out += '</ul>';
      document.getElementById('toc').innerHTML = out;
    })();
  </script>
</body>
</html>
`;
    res.send(html);
  }
};
