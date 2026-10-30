#!/usr/bin/env node
// Automated Klaviyo provisioning script for Eden (askeden.com, askedenedu.com, evesverification.com, edenrouter.com).
// Creates the 3 segmented Klaviyo lists and 5 welcome-series email templates via Klaviyo REST API (v2024-10-15).
//
// Usage:
//   KLAVIYO_PRIVATE_KEY=pk_... node scripts/setup-klaviyo.mjs
//   node scripts/setup-klaviyo.mjs --dry-run

const KLAVIYO_REVISION = '2024-10-15';
const dryRun = process.argv.includes('--dry-run') || !process.env.KLAVIYO_PRIVATE_KEY;
const apiKey = String(process.env.KLAVIYO_PRIVATE_KEY || '').trim();

const LISTS = [
  { envVar: 'KLAVIYO_LIST_ID', name: 'Eden · AI Power Users & General' },
  { envVar: 'KLAVIYO_EDU_LIST_ID', name: 'Eden · Educators & Faculty Pilots' },
  { envVar: 'KLAVIYO_API_LIST_ID', name: 'Eden · Developers, API & Research Agents' },
];

const wrapEmailHtml = (heading, bodyHtml) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${heading}</title></head>
<body style="margin:0;padding:32px 16px;background:#fbf7ee;color:#0E2747;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;">
  <div style="max-width:600px;margin:0 auto;background:#fffdf8;border:1px solid #ddd3bd;border-radius:14px;padding:32px;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#d9604f;font-weight:600;">Eden · Harrat Global Holdings, Inc.</p>
    <h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;color:#0E2747;">${heading}</h1>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #ddd3bd;margin:28px 0 16px;">
    <p style="margin:0;font-size:12px;color:#46556b;">© 2026 Harrat Global Holdings, Inc. · <a href="https://askeden.com" style="color:#0E2747;">askeden.com</a> · <a href="{% unsubscribe_link %}" style="color:#46556b;">Unsubscribe</a></p>
  </div>
</body>
</html>`;

export const EMAIL_TEMPLATES = [
  {
    name: 'Eden Welcome 1 · 432-Question EVES Benchmark Brief (Day 0)',
    subject: 'Why we tested 432 factual questions across Claude, Gemini, and EVES',
    html: wrapEmailHtml(
      'Why we tested 432 factual questions across Claude, Gemini, and EVES',
      `<p>Thanks for requesting the Eden research brief.</p>
      <p>Most AI tools force a bad trade-off: either you pay $20–$200/month for a single model that is overkill on 70% of prompts and still hallucinates on hard facts, or you stitch together multiple subscriptions yourself.</p>
      <p>We built <strong>Eden</strong> (<a href="https://askeden.com" style="color:#d9604f;">askeden.com</a>) around two core systems:</p>
      <ul>
        <li><strong>Eden Router v2:</strong> Reads each prompt in ~6.2 µs warm and routes it to the best-performing model for the lowest cost across Claude, GPT, Gemini, and Kimi—showing you the pick, effort, price, and time <em>before</em> you send.</li>
        <li><strong>EVES (Eden’s verification and evaluation system):</strong> Searches the web when a factual question looks risky, checks a question’s assumptions first, and verifies factual claims afterwards.</li>
      </ul>
      <p><strong>Read the resources:</strong></p>
      <ul>
        <li><a href="https://askeden.com/accuracy" style="color:#0E2747;">The 432-Question Hallucination Benchmark</a> (9.7% vs. 18.3%–24.5%)</li>
        <li><a href="https://askeden.com/guides" style="color:#0E2747;">Technical Guides: Model Routing, EVES &amp; Education</a></li>
        <li><a href="https://askeden.com/signin" style="color:#d9604f;font-weight:600;">Start in your browser — free</a></li>
      </ul>
      <p>— Bilel Harrat<br>Founder, Harrat Global Holdings, Inc.</p>`,
    ),
  },
  {
    name: 'Eden Welcome 2 · The Cost & Quality Calculus (Day 2)',
    subject: 'Why a $10/mo routed AI beats a $20/mo single-model subscription',
    html: wrapEmailHtml(
      'Why a $10/mo routed AI beats a $20/mo single-model subscription',
      `<p>When you use one AI provider all day, every quick rewrite or syntax check runs on the same billing tier as your hardest debugging or research prompt—and you still hit that single model’s blind spots.</p>
      <p>On 44 graded tasks across 18 frontier models:</p>
      <ul>
        <li>Always using Claude Opus 5.5 cost <strong>$0.031 per task</strong>.</li>
        <li>Eden Router Level 3 passed <strong>93% of tasks at $0.013 per task</strong> (2.4× cheaper), and Level 4 passed <strong>98%</strong>.</li>
      </ul>
      <p>Because the router does the efficiency-vs-performance calculus on every turn, <strong>Eden Plus is $10/month</strong> ($96/year)—half the price of single-model subscriptions.</p>
      <p><a href="https://askeden.com/guides/ai-model-router-cut-llm-costs" style="color:#d9604f;font-weight:600;">Read the full routing guide →</a></p>
      <p>— Bilel</p>`,
    ),
  },
  {
    name: 'Eden Welcome 3 · EVES Verification & Router API (Day 4 · Power Users & API)',
    subject: 'Stopping AI agents from hallucinating with EVES and Eden Router',
    html: wrapEmailHtml(
      'How EVES and Eden Router verify factual claims in production AI agents',
      `<p>When engineering teams build autonomous AI agents to draft reports and analyses, the prose looks fluent—until unverified models fabricate figures or repeat flawed assumptions from prompts.</p>
      <p>Instead of replacing your custom agent stack, you can plug <strong>EVES + Eden Router</strong> into your pipeline via our OpenAI-compatible API:</p>
      <ol>
        <li><strong>Risk-aware routing (0–100 reliability score)</strong> shifts financial and citation prompts to the highest-reliability models.</li>
        <li><strong>Pre-answer assumption checking</strong> catches false premises before drafting (3.0% false-premise repetition across 132 adversarial prompts).</li>
        <li><strong>Live web grounding + post-answer claim audit</strong> verifies atomic claims or flags them for review.</li>
      </ol>
      <p><a href="https://askeden.com/guides/plugging-hallucination-verification-api-into-ai-agents" style="color:#d9604f;font-weight:600;">Read the Agent API Integration Guide →</a></p>
      <p>Building an agent pipeline where hallucinations are expensive? Reply directly to this email and I’ll set you up with an API key.</p>
      <p>— Bilel</p>`,
    ),
  },
  {
    name: 'Eden Welcome 3-Edu · 5-Minute Syllabus Course Pilot (Day 2 · Educators)',
    subject: 'How professors set up a syllabus-verified AI tutor in 5 minutes (free for students)',
    html: wrapEmailHtml(
      'A study assistant built only from your syllabus, slides, and readings',
      `<p>Students are already using AI at 2 a.m. when they get stuck. The problem with consumer chatbots is that they guess from the open web, use notation that contradicts your lectures, or make things up.</p>
      <p><strong>Eden for Education</strong> (<a href="https://askeden.com/edu" style="color:#d9604f;">askeden.com/edu</a>) lets you drop in your syllabus, lecture slides (PDF/PowerPoint), and readings:</p>
      <ul>
        <li><strong>Every answer cites the exact slide or page, checked word for word.</strong></li>
        <li><strong>Anything outside your materials is labeled</strong> (or blocked, under your rules).</li>
        <li><strong>Students never pay</strong>, and no IT procurement is required—share a 6-character join code or connect via Canvas/Moodle LTI 1.3.</li>
      </ul>
      <p><a href="https://askeden.com/guides/ai-tutor-for-university-courses-syllabus-slides" style="color:#d9604f;font-weight:600;">Read the faculty setup guide →</a></p>
      <p>Want me to build a ready-to-try pilot course from your syllabus? Reply to this email with your syllabus or a lecture deck and I’ll set it up for you personally.</p>
      <p>— Bilel Harrat</p>`,
    ),
  },
  {
    name: 'Eden Welcome 4 · Compare Models Side-by-Side + Desktop Companions (Day 7)',
    subject: 'Ask three AI models at once—and let EVES check where they disagree',
    html: wrapEmailHtml(
      'Ask several models at once. Get one verified answer.',
      `<p>One of the fastest ways to test Eden on your hardest work is <strong>multi-model comparison</strong>:</p>
      <ol>
        <li>Sign in at <a href="https://askeden.com/signin" style="color:#d9604f;">askeden.com/signin</a> (free included AI allowance, no card required).</li>
        <li>Ask a complex question from your current project or coursework.</li>
        <li>Compare models side by side and let <strong>EVES</strong> check the facts they disagree on.</li>
      </ol>
      <p>If you work on a Mac or Windows machine, you can also link <strong>Eden Secretary</strong> (for local files, calendar, and voice) or <strong>Eden Code</strong> (<a href="https://askeden.com/eden-code" style="color:#0E2747;">askeden.com/eden-code</a>) for local software engineering.</p>
      <p>— Bilel</p>`,
    ),
  },
];

async function klaviyoPost(path, payload) {
  if (dryRun) {
    return { data: { id: `dry_${Math.random().toString(36).slice(2, 8)}` } };
  }
  const res = await fetch(`https://a.klaviyo.com/api${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.api+json',
      'content-type': 'application/vnd.api+json',
      revision: KLAVIYO_REVISION,
      authorization: `Klaviyo-API-Key ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Klaviyo ${path} failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body;
}

async function main() {
  console.log(dryRun ? '[setup-klaviyo] Running in DRY-RUN mode (set KLAVIYO_PRIVATE_KEY to provision live)' : '[setup-klaviyo] Provisioning live Klaviyo lists and templates...');
  const createdLists = {};
  for (const list of LISTS) {
    const out = await klaviyoPost('/lists/', {
      data: { type: 'list', attributes: { name: list.name } },
    });
    createdLists[list.envVar] = out?.data?.id || '';
    console.log(`  ✓ List "${list.name}" -> ${list.envVar} = "${createdLists[list.envVar]}"`);
  }

  for (const tpl of EMAIL_TEMPLATES) {
    const out = await klaviyoPost('/templates/', {
      data: {
        type: 'template',
        attributes: {
          name: tpl.name,
          editor_type: 'CODE',
          html: tpl.html,
        },
      },
    });
    console.log(`  ✓ Template "${tpl.name}" -> id=${out?.data?.id || ''}`);
  }

  console.log('\nAdd these list IDs to JARVIS V1/site/wrangler.toml [vars] (or via wrangler secret put):');
  for (const [k, v] of Object.entries(createdLists)) {
    console.log(`  ${k} = "${v}"`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
