// Search indexing and discovery across every Eden domain:
//   GET /robots.txt      crawl rules + host-aware Sitemap pointer
//   GET /sitemap.xml     canonical XML sitemap with hreflang alternates, per-domain pages,
//                        and the SEO guides catalog.
//
// All content metadata here is shared with the static guides builder (scripts/build-guides.mjs)
// so sitemap.xml, /guides, and the static HTML pages never drift.

export const LAST_MOD = '2026-10-21';

export const CASE_STUDIES = [];

export const GUIDES = [
  {
    slug: 'stop-ai-hallucinations-investment-memos',
    path: '/guides/stop-ai-hallucinations-investment-memos',
    title: 'How to Stop AI Hallucinations in Financial & Enterprise Analysis',
    description:
      'Why frontier LLMs fabricate citations and market figures during complex synthesis, and how a four-stage verification pipeline (EVES) reduces fabricated claims to 9.7% on 432 factual questions.',
    kicker: 'GUIDE · HALLUCINATION MITIGATION',
    audience: 'api',
    published: '2026-10-21',
    readMinutes: 7,
    keywords: ['AI hallucinations financial analysis', 'enterprise AI verification', 'EVES benchmark', 'hallucination mitigation API'],
  },
  {
    slug: 'ai-model-router-cut-llm-costs',
    path: '/guides/ai-model-router-cut-llm-costs',
    title: 'AI Model Router vs. Single-Model Subscriptions: Cutting LLM Costs in Half Without Losing Quality',
    description:
      'How query-level routing across Claude, GPT, Gemini, and Kimi matches each prompt to the right model and reasoning effort in ~6.2 µs warm—delivering flagship quality at a $10/month subscription or via an OpenAI-compatible API.',
    kicker: 'GUIDE · MODEL ROUTING & COST CALCULUS',
    audience: 'power-user',
    published: '2026-10-21',
    readMinutes: 8,
    keywords: ['AI model router', 'LLM routing cost optimization', 'multi-model AI subscription', 'OpenAI compatible model router'],
  },
  {
    slug: 'ai-tutor-for-university-courses-syllabus-slides',
    path: '/guides/ai-tutor-for-university-courses-syllabus-slides',
    title: 'AI-Assisted Workflows for Educators: Building a Course Tutor Grounded Only in Your Syllabus & Slides',
    description:
      'A practical guide for university professors and instructional designers: how to give students a 24/7 AI study assistant that cites the exact lecture slide or textbook page word for word and refuses to fabricate answers.',
    kicker: 'GUIDE · HIGHER EDUCATION & SYLLABUS GROUNDING',
    audience: 'educator',
    published: '2026-10-21',
    readMinutes: 7,
    keywords: ['AI tutor for university courses', 'AI-assisted workflows for educators', 'syllabus grounded AI study assistant', 'prevent AI hallucinations in education'],
  },
  {
    slug: 'how-we-tested-432-factual-questions-eves-benchmark',
    path: '/guides/how-we-tested-432-factual-questions-eves-benchmark',
    title: 'Inside the 432-Question Hallucination Benchmark: EVES vs. Gemini 3.1 Pro, Gemini 3.8 Flash & Claude Sonnet 5.5',
    description:
      'A transparent look at how we evaluated 300 SimpleQA Verified factual questions and 132 false-premise questions, why confidence intervals and abstention rates matter, and where verification helps most.',
    kicker: 'GUIDE · BENCHMARK METHODOLOGY',
    audience: 'power-user',
    published: '2026-10-21',
    readMinutes: 9,
    keywords: ['AI hallucination benchmark', 'SimpleQA Verified evaluation', 'false premise LLM benchmark', 'EVES verification system'],
  },
  {
    slug: 'plugging-hallucination-verification-api-into-ai-agents',
    path: '/guides/plugging-hallucination-verification-api-into-ai-agents',
    title: 'Adding a Hallucination Verification Layer & Risk-Aware Router to Existing AI Agents',
    description:
      'Architecture patterns for engineering teams: how to keep your existing agent framework and drop in risk-aware model routing, cross-provider failover chains, and post-generation claim verification.',
    kicker: 'GUIDE · AGENT ARCHITECTURE & API',
    audience: 'api',
    published: '2026-10-21',
    readMinutes: 8,
    keywords: ['AI agent hallucination verification API', 'risk-aware LLM routing', 'speculative cascade LLM', 'OpenAI drop-in router'],
  },
  {
    slug: 'canvas-lti-ai-study-assistant-for-professors',
    path: '/guides/canvas-lti-ai-study-assistant-for-professors',
    title: 'How Professors Run a Free AI Tutor Pilot Without IT Procurement Delays',
    description:
      'Public universities and colleges have slow purchasing cycles. Here is how individual instructors launch a syllabus-verified Eden for Education course in five minutes—with join codes or LTI 1.3—at zero cost to students.',
    kicker: 'GUIDE · FACULTY ADOPTION & PILOTS',
    audience: 'educator',
    published: '2026-10-21',
    readMinutes: 6,
    keywords: ['free AI tutor for college students', 'Canvas LTI AI study tool', 'professor AI course pilot', 'Eden for Education'],
  },
];

const GUIDE_SLUGS = new Set(GUIDES.map((g) => g.slug));
const CASE_STUDY_SLUGS = new Set(CASE_STUDIES.map((c) => c.slug));

export const isGuideSlug = (slug) => GUIDE_SLUGS.has(slug);
export const isCaseStudySlug = (slug) => CASE_STUDY_SLUGS.has(slug);

/** Canonical origin for the request's host. */
function canonicalOrigin(request, env) {
  const host = new URL(request.url).hostname.toLowerCase().replace(/^www\./, '');
  const eduHost = String(env?.EDU_HOST || '').toLowerCase();
  const codeHost = String(env?.CODE_HOST || '').toLowerCase();
  const routerHost = String(env?.ROUTER_HOST || '').toLowerCase();
  const evesHost = String(env?.EVES_HOST || '').toLowerCase();
  const secHost = String(env?.SECRETARY_HOST || '').toLowerCase();
  const dareHost = String(env?.DAREDEVIL_HOST || '').toLowerCase();
  const mailHost = String(env?.MAIL_HOST || '').toLowerCase();
  const newsHost = String(env?.NEWS_HOST || '').toLowerCase();
  const bizHost = String(env?.BUSINESS_HOST || '').toLowerCase();
  if (eduHost && host === eduHost) return `https://${eduHost}`;
  if (codeHost && host === codeHost) return `https://${codeHost}`;
  if (routerHost && host === routerHost) return `https://${routerHost}`;
  if (evesHost && host === evesHost) return `https://${evesHost}`;
  if (secHost && host === secHost) return `https://${secHost}`;
  if (dareHost && host === dareHost) return `https://${dareHost}`;
  if (mailHost && host === mailHost) return `https://${mailHost}`;
  if (newsHost && host === newsHost) return `https://${newsHost}`;
  if (bizHost && host === bizHost) return `https://${bizHost}`;
  return 'https://askeden.com';
}

/** URL entries for a given host's sitemap.xml. */
function entriesForHost(origin, env) {
  const host = new URL(origin).hostname;
  const eduHost = String(env?.EDU_HOST || '').toLowerCase();
  const codeHost = String(env?.CODE_HOST || '').toLowerCase();
  const routerHost = String(env?.ROUTER_HOST || '').toLowerCase();
  const evesHost = String(env?.EVES_HOST || '').toLowerCase();
  const secHost = String(env?.SECRETARY_HOST || '').toLowerCase();
  const dareHost = String(env?.DAREDEVIL_HOST || '').toLowerCase();
  const mailHost = String(env?.MAIL_HOST || '').toLowerCase();
  const newsHost = String(env?.NEWS_HOST || '').toLowerCase();
  const bizHost = String(env?.BUSINESS_HOST || '').toLowerCase();

  if (eduHost && host === eduHost) {
    return [
      { loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: true },
      { loc: `${origin}/edu/privacy`, priority: '0.5', changefreq: 'monthly', i18n: true },
      { loc: `${origin}/edu/terms`, priority: '0.5', changefreq: 'monthly', i18n: true },
    ];
  }
  if (codeHost && host === codeHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: false }];
  }
  if (routerHost && host === routerHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: true }];
  }
  if (evesHost && host === evesHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: false }];
  }
  if (secHost && host === secHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: false }];
  }
  if (dareHost && host === dareHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: true }];
  }
  if (mailHost && host === mailHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: false }];
  }
  if (newsHost && host === newsHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'daily', i18n: false }];
  }
  if (bizHost && host === bizHost) {
    return [{ loc: `${origin}/`, priority: '1.0', changefreq: 'weekly', i18n: false }];
  }

  // Primary askeden.com sitemap: core pages + case studies + SEO guides
  const core = [
    { loc: 'https://askeden.com/', priority: '1.0', changefreq: 'weekly', i18n: true },
    { loc: 'https://askeden.com/accuracy', priority: '0.9', changefreq: 'monthly', i18n: false },
    { loc: 'https://askeden.com/eves', priority: '0.9', changefreq: 'weekly', i18n: false },
    { loc: 'https://askeden.com/edu', priority: '0.9', changefreq: 'weekly', i18n: true },
    { loc: 'https://askeden.com/eden-code', priority: '0.8', changefreq: 'weekly', i18n: false },
    { loc: 'https://askeden.com/eden-secretary', priority: '0.8', changefreq: 'weekly', i18n: false },
    { loc: 'https://askeden.com/daredevil', priority: '0.8', changefreq: 'weekly', i18n: true },
    { loc: 'https://askeden.com/mail', priority: '0.8', changefreq: 'weekly', i18n: false },
    { loc: 'https://askeden.com/download', priority: '0.8', changefreq: 'weekly', i18n: true },
    { loc: 'https://askeden.com/help', priority: '0.7', changefreq: 'weekly', i18n: false },
    { loc: 'https://askeden.com/guides', priority: '0.9', changefreq: 'weekly', i18n: false },
    ...CASE_STUDIES.map((c) => ({
      loc: `https://askeden.com${c.path}`,
      priority: '0.9',
      changefreq: 'monthly',
      lastmod: c.published,
      i18n: false,
    })),
    ...GUIDES.map((g) => ({
      loc: `https://askeden.com${g.path}`,
      priority: '0.8',
      changefreq: 'monthly',
      lastmod: g.published,
      i18n: false,
    })),
    { loc: 'https://askeden.com/privacy', priority: '0.4', changefreq: 'monthly', i18n: true },
    { loc: 'https://askeden.com/terms', priority: '0.4', changefreq: 'monthly', i18n: true },
  ];
  if (env?.ROUTER_HOST) {
    core.splice(3, 0, { loc: 'https://askeden.com/router', priority: '0.9', changefreq: 'weekly', i18n: true });
  }
  return core;
}

const escXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** GET /robots.txt */
export function robotsTxt(request, env) {
  const origin = canonicalOrigin(request, env);
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /s/',
    'Disallow: /link',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** GET /sitemap.xml */
export function sitemapXml(request, env) {
  const origin = canonicalOrigin(request, env);
  const entries = entriesForHost(origin, env);
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod || LAST_MOD;
      const hreflang = e.i18n
        ? `\n    <xhtml:link rel="alternate" hreflang="en" href="${escXml(e.loc)}"/>` +
          `\n    <xhtml:link rel="alternate" hreflang="fr" href="${escXml(e.loc)}${e.loc.includes('?') ? '&amp;' : '?'}lang=fr"/>` +
          `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escXml(e.loc)}"/>`
        : '';
      return `  <url>\n    <loc>${escXml(e.loc)}</loc>\n    <lastmod>${escXml(lastmod)}</lastmod>\n    <changefreq>${escXml(e.changefreq)}</changefreq>\n    <priority>${escXml(e.priority)}</priority>${hreflang}\n  </url>`;
    })
    .join('\n');
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${urls}\n` +
    `</urlset>\n`;
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
