#!/usr/bin/env node
// Generates the static SEO Guides & Case Studies pages under public/guides/ and public/case-studies/
// from structured content definitions, sharing metadata with src/eden/seo.js.
// Every generated page follows DESIGN.md (Paper look) and FRONT_CSP (no inline styles or scripts;
// Schema.org Article + FAQPage Microdata in HTML; /home/features.js for lead capture and telemetry).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_STUDIES, GUIDES } from '../src/eden/seo.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(SITE, 'public');

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CONTENT = {
  'stop-ai-hallucinations-investment-memos': {
    breadcrumb: 'Guide · Hallucination Mitigation',
    ctaPrimary: { label: 'Explore EVES', href: '/eves' },
    ctaSecondary: { label: 'See the 432-question benchmark', href: '/accuracy' },
    leadHeading: 'Get the Hallucination Mitigation Checklist & EVES Benchmark PDF',
    leadSub: 'Learn how engineering, legal, and analysis teams structure multi-stage verification to catch fabricated claims before they ship.',
    bodyHtml: `
      <p>When teams use large language models to draft financial analyses, competitive teardowns, or due-diligence briefs, they run into a predictable failure mode: <b>models optimize for plausible continuation, not epistemic certainty.</b> Ask a single model from memory for a private company’s net dollar retention or a sub-sector’s 5-year CAGR, and it will often state an unverified number with total confidence.</p>

      <h2>The three root causes of hallucinations in enterprise synthesis</h2>
      <ol>
        <li><b>Parametric compression loss:</b> Even frontier models compress trillions of training tokens into weights. Exact figures, dates, citations, and minority edge cases blur together unless grounded at inference time.</li>
        <li><b>Sycophantic premise acceptance:</b> If a prompt contains a mistaken assumption (“Given that Company Y’s gross margin fell in 2025, explain why…”), standard instruction-tuned models try to satisfy the user’s premise rather than challenge it.</li>
        <li><b>Single-model blind spots:</b> No single provider dominates every domain. A model chosen for low cost on routine summarization may have a >25% fabrication rate on dense factual recall.</li>
      </ol>

      <h2>A four-stage architecture for zero-trust synthesis</h2>
      <p>In <a href="/eves">EVES</a> (Eden’s verification and evaluation system), we found that stopping hallucinations requires intervening both <b>before</b> and <b>after</b> generation:</p>

      <div class="steps-grid">
        <div class="step-card">
          <small>STAGE 1 · RISK-AWARE ROUTING</small>
          <h3>Route by factual risk, not just token length</h3>
          <p>Eden Router scores every prompt for factual risk (medical, legal, financial, citations, named entities) and shifts risky prompts toward higher-reliability models and higher reasoning effort.</p>
        </div>
        <div class="step-card">
          <small>STAGE 2 · PRE-GENERATION SEARCH</small>
          <h3>Ground volatile facts before drafting</h3>
          <p>When a prompt asks for specific figures, filings, or events, EVES runs targeted web retrieval first so the generator synthesizes from retrieved evidence rather than memory.</p>
        </div>
        <div class="step-card">
          <small>STAGE 3 · PREMISE VERIFICATION</small>
          <h3>Audit the prompt’s assumptions</h3>
          <p>Before answering a “why” or “how much” question, verify that the underlying entity, event, or directional trend in the question actually occurred.</p>
        </div>
        <div class="step-card">
          <small>STAGE 4 · POST-ANSWER CLAIM AUDIT</small>
          <h3>Verify atomic claims &amp; allow abstention</h3>
          <p>Check factual claims in the draft against independent sources afterwards. When sources conflict or don’t exist, explicitly say so instead of guessing.</p>
        </div>
      </div>

      <h2>Benchmark evidence: 432 factual &amp; false-premise questions</h2>
      <p>Across 300 SimpleQA Verified questions and 132 false-premise questions, EVES stated something false <b>9.7%</b> of the time (95% CI: 7.3%–12.9%), cutting hallucinations by more than half compared to Claude Sonnet 5.5 (24.5%) and Gemini 3.8 Flash (21.8%) answering from memory. Explore <a href="/eves">EVES</a> and the <a href="/accuracy">full 432-question benchmark</a> to see how this architecture works.</p>
    `,
    faqs: [
      {
        q: 'Why does RAG alone still hallucinate in financial analysis?',
        a: 'Standard RAG retrieves top-k chunks by embedding similarity, even when none of the chunks actually answer the question or when the user’s prompt contains a false premise. Without premise auditing and post-generation claim verification, models still extrapolate beyond the retrieved text.',
      },
      {
        q: 'How much does verification reduce false-premise hallucinations?',
        a: 'On 132 false-premise questions, EVES made up an answer only 3.0% of the time (vs. 10.6% for Gemini 3.8 Flash).',
      },
    ],
  },

  'ai-model-router-cut-llm-costs': {
    breadcrumb: 'Guide · Model Routing & Cost Calculus',
    ctaPrimary: { label: 'Try Eden Free ($0 to start, $10/mo Plus)', href: '/signin' },
    ctaSecondary: { label: 'Interactive Router Benchmark', href: '/accuracy' },
    leadHeading: 'Get the Model Router Cost & Quality Benchmark Brief',
    leadSub: 'See the task-by-task breakdown across 18 models and 44 graded benchmarks—and how routing cuts subscription and API spend in half.',
    bodyHtml: `
      <p>Most AI power users and engineering teams overpay for intelligence in one of two ways: either they pay $20 to $200/month per seat for a single provider’s subscription (even when 70% of their daily prompts are routine), or they hardcode a flagship model like Claude Opus 5.5 on every API call at $0.031 per task.</p>
      <p><b>Eden’s Model Router solves the calculus between efficiency and performance automatically.</b> Instead of locking you into one provider, it inspects each query in <b>~6.2 µs warm (~40 µs cold)</b> and routes it to the model and reasoning effort that maximizes expected quality per dollar.</p>

      <h2>How query-level routing makes a $10/month subscription possible</h2>
      <p>In a typical workday, a power user’s prompts span four distinct complexity tiers:</p>
      <ul>
        <li><b>Simple (~30% of prompts):</b> Quick rewrites, formatting, syntax lookups, and short translations. Flagship reasoning tokens are wasted here.</li>
        <li><b>Moderate (~35% of prompts):</b> Drafting emails, summarizing documents, standard SQL or React components.</li>
        <li><b>Complex (~25% of prompts):</b> Multi-file debugging, financial modeling, comparative research with citations.</li>
        <li><b>Expert (~10% of prompts):</b> Formal proofs, concurrency race conditions, compiler design, and high-stakes factual synthesis.</li>
      </ul>

      <div class="tablebox">
        <table>
          <caption class="sr">Eden Router v2 levels vs single-model baselines on 44 graded tasks</caption>
          <thead>
            <tr><th scope="col">Routing Strategy</th><th scope="col">Tasks Passed</th><th scope="col">Mean Score</th><th scope="col">Avg Cost / Task</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Level 1 · Max Efficiency</th><td>86%</td><td>0.85</td><td>$0.0035</td></tr>
            <tr><th scope="row">Level 2 · Efficient</th><td>91%</td><td>0.90</td><td>$0.0058</td></tr>
            <tr class="highlight"><th scope="row">Level 3 · Balanced (Default)</th><td>93%</td><td>0.95</td><td>$0.0130</td></tr>
            <tr class="highlight"><th scope="row">Level 4 · Performance</th><td>98%</td><td>0.99</td><td>$0.0240</td></tr>
            <tr><th scope="row">Always Claude Opus 5.5</th><td>100%</td><td>1.00</td><td>$0.0310</td></tr>
            <tr><th scope="row">Always Claude Haiku 4.5</th><td>50%</td><td>0.51</td><td>$0.0071</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Transparency before and after you send</h2>
      <p>Unlike opaque routers that silently downgrade your model to save money, Eden shows its pick <b>before you press send</b>: the chosen model, the reasoning effort, the estimated price, and the expected response time—and lets you pin any model or compare several models side by side whenever you want.</p>
    `,
    faqs: [
      {
        q: 'Can I still pin a specific model like Claude Sonnet 5.5, GPT-6.1 Sol, or Gemini 4 Argon in Eden?',
        a: 'Yes. Eden routes automatically by default and shows its pick before you send, but you can override and pin any model—or ask several models side by side and let EVES check the facts they disagree on.',
      },
      {
        q: 'How fast is the router decision itself?',
        a: 'Eden Router v2’s rule analyzer runs in ~6.2 microseconds warm (~40 microseconds cold) with zero network calls, achieving 100% 4-tier complexity classification accuracy on our benchmark suite.',
      },
    ],
  },

  'ai-tutor-for-university-courses-syllabus-slides': {
    breadcrumb: 'Guide · Higher Education & Syllabus Grounding',
    ctaPrimary: { label: 'Try Eden for Education Free', href: '/edu' },
    ctaSecondary: { label: 'Request a Free Faculty Pilot', href: '/edu#pilot' },
    leadHeading: 'Professors: Get a Free Pilot Course Built From Your Syllabus',
    leadSub: 'Send us your school email and course name—we will send the 5-minute setup guide or configure a pilot course from your slides at zero cost to students.',
    bodyHtml: `
      <p>Every university professor faces the same reality today: <b>students are going to use AI to study.</b> When students paste homework or exam review questions into generic consumer chatbots, they get unverified answers drawn from the open web, notation that contradicts the lecture slides, or complete fabrications.</p>
      <p><a href="/edu">Eden for Education</a> flips that dynamic. Professors upload their own syllabus, lecture slides (PDF/PowerPoint), and readings, and distribute the course to students with a single join code or Canvas/Moodle LTI link.</p>

      <h2>Two guarantees that make faculty and students trust the workflow</h2>
      <div class="steps-grid">
        <div class="step-card">
          <small>01 · FOR STUDENTS</small>
          <h3>Personalized study, cited to the exact slide</h3>
          <p>Students ask questions at 2 a.m., generate flashcards, take practice quizzes, or talk out loud with the voice tutor. Every answer cites the exact lecture slide or textbook page word for word.</p>
        </div>
        <div class="step-card">
          <small>02 · FOR PROFESSORS</small>
          <h3>Verified on your curriculum, zero BS</h3>
          <p>Every claim is checked word-for-word against the materials you uploaded. Anything outside your course materials is clearly labeled—or blocked entirely if you set strict course-only rules.</p>
        </div>
      </div>

      <h2>What happens when a student asks a question in Eden for Education</h2>
      <ol>
        <li><b>Course-scoped retrieval:</b> Eden searches only the current course’s syllabus, slides, and readings first.</li>
        <li><b>Word-for-word quote verification:</b> Citations point to the exact slide or page (for example, <code>Lecture 5 · Cellular respiration · slide 22</code>), and students can click the citation to open the slide with the passage highlighted.</li>
        <li><b>Pedagogical guardrails:</b> Professors choose whether Eden coaches step-by-step (Socratic mode) and never writes graded essays or problem-set solutions for the student.</li>
        <li><b>Anonymous class insights:</b> Professors see which lecture topics students ask about most before the midterm—without ever exposing which student asked what.</li>
      </ol>

      <div class="callout">
        <b>Private by design &amp; free for students</b>
        <p>Course materials are never used to train AI models and are deleted when the course is deleted. Students join for free with a class code.</p>
      </div>
    `,
    faqs: [
      {
        q: 'How long does it take a professor to set up a course in Eden for Education?',
        a: 'Under five minutes. Drop in your syllabus, PDFs, PowerPoint decks, or Word files; Eden indexes them with slide and page numbers and gives you a one-click join code for students.',
      },
      {
        q: 'What if a student asks a question that isn’t covered in my uploaded slides?',
        a: 'You control the rule per course: Eden can either restrict answers strictly to your uploaded materials or provide a general answer with an explicit badge stating that the topic is outside the course materials.',
      },
    ],
  },

  'how-we-tested-432-factual-questions-eves-benchmark': {
    breadcrumb: 'Guide · Benchmark Methodology',
    ctaPrimary: { label: 'View the Full Interactive Chart', href: '/accuracy' },
    ctaSecondary: { label: 'Explore EVES', href: '/eves' },
    leadHeading: 'Get the Full 432-Question Evaluation Report',
    leadSub: 'Receive our complete methodology notes, confidence-interval math, and updates as new frontier models are tested.',
    bodyHtml: `
      <p>Marketing benchmarks in AI often cherry-pick tasks where a vendor’s system wins and hide the caveats in footnotes. When we built <b>EVES</b> (Eden’s verification and evaluation system), we wanted a benchmark that tested two things critical to real-world professional and academic work: <b>hard factual recall</b> and <b>resistance to false premises</b>.</p>

      <h2>The 432-question evaluation suite</h2>
      <ul>
        <li><b>300 short factual questions from SimpleQA Verified</b> (Google DeepMind &amp; Google Research, MIT licence): unambiguous, fact-seeking questions where parametric memory often fails.</li>
        <li><b>132 false-premise questions</b> (100 from <b>MultiHoax / MHFPQ</b>, CC BY 4.0, plus 32 written by us): questions containing a fabricated premise designed to test whether the system points out the false assumption or plays along.</li>
      </ul>

      <h2>Results across all 432 questions (9 October 2026)</h2>
      <div class="tablebox">
        <table>
          <caption class="sr">Complete results across 432 questions with Wilson 95% confidence intervals</caption>
          <thead>
            <tr><th scope="col">System / Model</th><th scope="col">Made Up</th><th scope="col">95% CI</th><th scope="col">Right</th><th scope="col">Said It Didn’t Know</th></tr>
          </thead>
          <tbody>
            <tr class="highlight"><th scope="row">EVES</th><td>9.7% (42/432)</td><td>7.3%–12.9%</td><td>69.7%</td><td>20.6%</td></tr>
            <tr><th scope="row">Gemini 3.1 Pro (preview)</th><td>18.3% (79/432)</td><td>14.9%–22.2%</td><td>80.8%</td><td>0.9%</td></tr>
            <tr><th scope="row">Gemini 3.8 Flash</th><td>21.8% (94/432)</td><td>18.1%–25.9%</td><td>78.0%</td><td>0.2%</td></tr>
            <tr><th scope="row">Claude Sonnet 5.5</th><td>24.5% (106/432)</td><td>20.7%–28.8%</td><td>59.0%</td><td>16.4%</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Four caveats we publish alongside every chart</h2>
      <ol>
        <li><b>EVES declines more often:</b> EVES abstained on 20.6% of questions (vs. &lt;1% for the Gemini models). Both Gemini models answered more questions right overall than EVES did, because they guessed on almost every question—getting many right, but also fabricating nearly twice as often.</li>
        <li><b>Web search accounts for ~60% of the gain over Claude Sonnet 5.5:</b> The three baseline models answered from memory without web search.</li>
        <li><b>Single run on a fixed date:</b> Measured on 9 October 2026 without OpenAI models enabled in that EVES configuration.</li>
        <li><b>Automated &amp; judge grading limits:</b> Graded by rule and an AI judge; see <a href="/accuracy">askeden.com/accuracy</a> for the full protocol.</li>
      </ol>
    `,
    faqs: [
      {
        q: 'Why is "Made something up" separated from "Said it didn’t know"?',
        a: 'Because in high-stakes work—medicine, law, finance, and university coursework—an honest "I cannot verify this" is safe, whereas a confident fabrication causes real damage.',
      },
      {
        q: 'Where can I inspect the exact grading rules and datasets?',
        a: 'Visit askeden.com/accuracy#method for the full dataset citations (SimpleQA Verified and MHFPQ), confidence interval formulas, and judge rubrics.',
      },
    ],
  },

  'plugging-hallucination-verification-api-into-ai-agents': {
    breadcrumb: 'Guide · Agent Architecture & API',
    ctaPrimary: { label: 'Explore EVES', href: '/eves' },
    ctaSecondary: { label: 'See the 432-question benchmark', href: '/accuracy' },
    leadHeading: 'Request Private-Beta Access to the Eden Router & EVES API',
    leadSub: 'Tell us about your agent pipeline and we will send API documentation, latency benchmarks, and onboarding credentials.',
    bodyHtml: `
      <p>As engineering teams move AI agents from demos into production—generating financial reports, legal summaries, clinical notes, or customer-facing workflows—they hit an architectural wall: <b>chaining unverified LLM calls compounds hallucination probability at every step.</b></p>
      <p>If a 4-step agent pipeline has a 15% fabrication risk at each step, the chance that the final report contains at least one fabricated claim approaches 48%.</p>

      <h2>Three drop-in API patterns for production agents</h2>
      <div class="steps-grid">
        <div class="step-card">
          <small>PATTERN 1 · POST /v1/route</small>
          <h3>Sub-50 µs risk &amp; complexity routing</h3>
          <p>Call the routing decision endpoint to classify prompt complexity, factual risk (0–100), and recommended model + reasoning effort before invoking your provider.</p>
        </div>
        <div class="step-card">
          <small>PATTERN 2 · POST /v1/route/failover</small>
          <h3>Cross-provider failover chains</h3>
          <p>Eliminate single-provider outages. Receive a ranked failover chain across Anthropic, OpenAI, Google, and Moonshot that preserves your factual reliability floor.</p>
        </div>
        <div class="step-card">
          <small>PATTERN 3 · POST /v1/route/cascade</small>
          <h3>Speculative cascades with risk bypass</h3>
          <p>Run a fast draft model with a frontier verifier on routine tasks—while automatically bypassing cheap drafts when factual hallucination risk is high.</p>
        </div>
        <div class="step-card">
          <small>PATTERN 4 · POST /v1/route/batch</small>
          <h3>Budget-capped batch optimization</h3>
          <p>Route hundreds of sub-queries under a strict <code>max_total_cost_usd</code> ceiling using greedy marginal-utility allocation.</p>
        </div>
      </div>

      <h2>Example: Risk-aware routing with telemetry</h2>
      <pre><code>curl https://edenrouter.com/v1/chat/completions \\
  -H "Authorization: Bearer $EDEN_ROUTER_KEY" \\
  -H "x-anthropic-key: $ANTHROPIC_API_KEY" \\
  -H "x-openai-key: $OPENAI_API_KEY" \\
  -H "x-gemini-key: $GEMINI_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "eden-router:level-3",
    "x_eden": {"risk_aware": true, "classifier": "auto"},
    "messages": [{"role": "user", "content": "Verify the 2025 revenue multiples cited in this draft report."}]
  }'</code></pre>
      <p>Explore <a href="/eves">EVES</a> and the <a href="/accuracy">432-question benchmark</a> to see how verification performs in practice.</p>
    `,
    faqs: [
      {
        q: 'Do I use my own OpenAI, Anthropic, and Gemini API keys?',
        a: 'Yes. You pass your provider keys in request headers (x-openai-key, x-anthropic-key, x-gemini-key, x-moonshot-key). Eden never stores your provider keys or your prompt/response text.',
      },
      {
        q: 'What happens when a high-risk prompt is sent to /v1/route/cascade?',
        a: 'When risk_aware detects a high-risk factual domain (finance, medicine, law, citations), the cascade automatically bypasses the cheap draft stage and routes directly to a high-reliability verifier model.',
      },
    ],
  },

  'canvas-lti-ai-study-assistant-for-professors': {
    breadcrumb: 'Guide · Faculty Adoption & Pilots',
    ctaPrimary: { label: 'Launch a Free Course on Eden Edu', href: '/edu' },
    ctaSecondary: { label: 'Request a Faculty Pilot', href: '/edu#pilot' },
    leadHeading: 'Run a Free Eden for Education Pilot in Your Next Term',
    leadSub: 'Leave your faculty or instructional-design email and we will help you set up a trial course from your syllabus in minutes.',
    bodyHtml: `
      <p>Public universities, state colleges, and community colleges have strict purchasing and requisition cycles. Even when a department chair loves a new instructional tool, committee approvals and vendor procurement can take six to twelve months.</p>
      <p><b>Eden for Education is designed so an individual professor or instructional designer can launch a course pilot in five minutes—with zero cost to students and zero IT requisition hurdles.</b></p>

      <h2>Two ways to roll out Eden for Education to your class</h2>
      <div class="steps-grid">
        <div class="step-card">
          <small>OPTION A · ZERO-IT JOIN CODE (2 MINUTES)</small>
          <h3>Upload slides, share a 6-character code</h3>
          <p>Sign in with your school email at <a href="/edu">askeden.com/edu</a>, drop in your syllabus and lecture PDFs/PowerPoints, and paste the class join code into your syllabus or announcement.</p>
        </div>
        <div class="step-card">
          <small>OPTION B · LTI 1.3 FOR CANVAS, MOODLE &amp; BLACKBOARD</small>
          <h3>One-click launch inside your LMS</h3>
          <p>Connect Eden for Education via standard LTI 1.3 so students open their verified course tutor, flashcards, and practice quizzes directly from their Canvas or Moodle course sidebar.</p>
        </div>
      </div>

      <h2>Why faculty committees and accessibility offices approve it</h2>
      <ul>
        <li><b>Students never pay:</b> Students get free access to their course materials, practice quizzes, flashcards, and study plans.</li>
        <li><b>Screen-reader &amp; voice-first accessibility:</b> Built alongside <a href="/daredevil">Eden Daredevil</a> with full VoiceOver support and a two-way voice tutor for blind and low-vision students.</li>
        <li><b>FERPA-conscious privacy:</b> Course documents are parsed locally on your device before text upload, never train external models, and show professors only anonymous topic trends—never individual student transcripts.</li>
      </ul>
    `,
    faqs: [
      {
        q: 'Do students have to pay for a subscription or enter a credit card?',
        a: 'Never. Students join your course with your class code or LMS link for free.',
      },
      {
        q: 'Can instructional designers test Eden for Education across multiple faculty sections?',
        a: 'Yes. Teaching-and-learning centers regularly run 1–2 course pilots in high-enrollment intro classes (Biology, Calculus, Chemistry, Economics, Statistics, CS) and review the anonymous topic insights with faculty.',
      },
    ],
  },
};

function renderPage({ meta, detail, isCaseStudy = false }) {
  const canonical = `https://askeden.com${meta.path}`;
  const related = GUIDES.filter((g) => g.slug !== meta.slug).slice(0, 4);
  const faqHtml = (detail.faqs || [])
    .map(
      (f) => `
        <div class="faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <h3 itemprop="name">${esc(f.q)}</h3>
          <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <p itemprop="text">${esc(f.a)}</p>
          </div>
        </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#fbf7ee">
<title>${esc(meta.title)} · Eden</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Eden">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="https://askeden.com/jarvis/eden-share.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://askeden.com/jarvis/eden-share.png">
<link rel="icon" type="image/svg+xml" href="/jarvis/eden-logo.svg">
<link rel="apple-touch-icon" href="/jarvis/eden-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/guides/guides.css">
<script src="/home/features.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to the main content</a>
<header class="top">
  <a class="brand" href="/" aria-label="Eden, askeden.com"><img src="/jarvis/eden-logo.svg" alt="" width="36" height="36"><span>Eden</span></a>
  <nav aria-label="Site"><a href="/guides">Guides</a><a href="/accuracy">Accuracy</a><a href="/edu">Education</a><a class="pill" href="/signin">Sign in</a></nav>
</header>

<main id="main" itemscope itemtype="https://schema.org/TechArticle">
  <meta itemprop="headline" content="${esc(meta.title)}">
  <meta itemprop="datePublished" content="${esc(meta.published)}">
  <meta itemprop="author" content="Harrat Global Holdings, Inc.">
  <header class="article-header">
    <p class="breadcrumb"><a href="/">Eden</a> · <a href="/guides">Guides</a> · ${esc(detail.breadcrumb)}</p>
    <p class="kicker">${esc(meta.kicker)}</p>
    <h1>${esc(meta.title)}<u aria-hidden="true"></u></h1>
    <p class="lede" itemprop="description">${esc(meta.description)}</p>
    <div class="meta-line">
      <span>Published ${esc(meta.published)}</span>
      <span>·</span>
      <span>${esc(meta.readMinutes)} min read</span>
      <span>·</span>
      <span>By Eden (Harrat Global Holdings, Inc.)</span>
    </div>
    <div class="cta">
      <a class="btn primary" href="${esc(detail.ctaPrimary.href)}">${esc(detail.ctaPrimary.label)}</a>
      <a class="btn" href="${esc(detail.ctaSecondary.href)}">${esc(detail.ctaSecondary.label)}</a>
    </div>
  </header>

  <div class="article-wrap">
    <article class="prose" itemprop="articleBody">
      ${detail.bodyHtml.trim()}

      ${
        faqHtml
          ? `<section itemscope itemtype="https://schema.org/FAQPage" aria-labelledby="faqH">
        <h2 id="faqH">Frequently asked questions</h2>
        <div class="faq-list">${faqHtml}</div>
      </section>`
          : ''
      }
    </article>

    <aside class="rail" aria-label="Related resources">
      <div class="rail-card navy">
        <h3>Try Eden in your browser</h3>
        <p>One chat that routes each question to the best model for the lowest cost, with EVES hallucination verification built in.</p>
        <a class="btn" href="/signin">Start free at askeden.com</a>
      </div>
      <div class="rail-card">
        <h3>More guides</h3>
        <ul class="rail-links">
          ${related.map((r) => `<li><a href="${esc(r.path)}">${esc(r.title)}</a></li>`).join('\n          ')}
          <li><a href="/accuracy">The 432-question EVES hallucination benchmark</a></li>
        </ul>
      </div>
    </aside>
  </div>

  <section class="lead-band" id="newsletter" aria-labelledby="leadH">
    <div>
      <p class="kicker">Technical brief &amp; updates</p>
      <h2 id="leadH">${esc(detail.leadHeading)}</h2>
      <p class="sub">${esc(detail.leadSub)}</p>
      <ul class="lead-perks">
        <li>Full 432-question EVES benchmark breakdown &amp; methodology</li>
        <li>Architecture notes on model routing and claim verification</li>
        <li>Zero spam; unsubscribe in one click</li>
      </ul>
    </div>
    <form class="lead-form" method="post" action="/api/leads" data-lead-form data-audience="${esc(meta.audience)}">
      <input class="sr" type="text" name="website_url" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="source_page" value="${esc(meta.path)}">
      <input type="hidden" name="audience" value="${esc(meta.audience)}">
      <input type="hidden" name="utm_source" value="">
      <input type="hidden" name="utm_medium" value="">
      <input type="hidden" name="utm_campaign" value="">
      <label>Email address
        <input type="email" name="email" required autocomplete="email" placeholder="you@company.com">
      </label>
      <div class="lead-row">
        <label>Organization or course (optional)
          <input type="text" name="organization" autocomplete="organization" placeholder="Company or university">
        </label>
        <label>Optional SMS updates
          <input type="tel" name="phone" autocomplete="tel" placeholder="+1 (555) 000-0000">
        </label>
      </div>
      <button class="btn primary" type="submit">Send me the technical brief</button>
      <p class="lead-status" data-lead-status role="status" aria-live="polite" hidden></p>
    </form>
  </section>
</main>

<footer>
  <span>© 2026 Harrat Global Holdings, Inc.</span>
  <nav aria-label="Legal and help"><a href="/">Eden</a><a href="/guides">Guides</a><a href="/accuracy">Accuracy</a><a href="/edu">Education</a><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</footer>
</body>
</html>
`;
}

function renderHub() {
  const cards = GUIDES.map(
    (g) => `
      <a class="guide-card" href="${esc(g.path)}">
        <div>
          <small>${esc(g.kicker)} · ${esc(g.readMinutes)} MIN</small>
          <h3>${esc(g.title)}</h3>
          <p>${esc(g.description)}</p>
        </div>
        <span class="more">Read guide →</span>
      </a>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#fbf7ee">
<title>Eden Guides · Model Routing, EVES Verification &amp; AI for Education</title>
<meta name="description" content="Technical guides and benchmarks on stopping AI hallucinations with EVES, cutting LLM costs in half with Eden Router, and running syllabus-grounded AI tutors.">
<link rel="canonical" href="https://askeden.com/guides">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Eden">
<meta property="og:url" content="https://askeden.com/guides">
<meta property="og:title" content="Eden Guides · Model Routing, EVES &amp; Education">
<meta property="og:description" content="How EVES cuts hallucinations to 9.7% on 432 factual questions, how Eden Router cuts LLM costs in half, and how professors deploy syllabus-verified AI tutors.">
<meta property="og:image" content="https://askeden.com/jarvis/eden-share.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/jarvis/eden-logo.svg">
<link rel="apple-touch-icon" href="/jarvis/eden-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/guides/guides.css">
<script src="/home/features.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to the main content</a>
<header class="top">
  <a class="brand" href="/" aria-label="Eden, askeden.com"><img src="/jarvis/eden-logo.svg" alt="" width="36" height="36"><span>Eden</span></a>
  <nav aria-label="Site"><a href="/">Eden</a><a href="/accuracy">Accuracy</a><a href="/edu">Education</a><a href="/eves">EVES</a><a class="pill" href="/signin">Sign in</a></nav>
</header>

<main id="main" itemscope itemtype="https://schema.org/CollectionPage">
  <section class="hub-hero" aria-labelledby="hubH">
    <p class="kicker">Eden · Technical Guides</p>
    <h1 id="hubH" itemprop="name">Measured AI routing, verification, and course grounding<u aria-hidden="true"></u></h1>
    <p class="lede" itemprop="description">Engineering notes, 432-question hallucination benchmarks, and faculty playbooks from the team building Eden, EVES, Eden Router, and Eden for Education.</p>
  </section>

  <section class="catalog-section" aria-labelledby="catH">
    <p class="kicker">Technical Guides</p>
    <h2 id="catH">Deep dives by topic</h2>
    <div class="catalog-grid">
      ${cards}
    </div>
  </section>

  <section class="lead-band" id="newsletter" aria-labelledby="leadH">
    <div>
      <p class="kicker">Free 4-part brief</p>
      <h2 id="leadH">Get new benchmarks &amp; routing guides by email</h2>
      <p class="sub">Join engineers, analysts, and educators receiving our benchmark reports and technical guides.</p>
      <ul class="lead-perks">
        <li>The 432-question EVES hallucination benchmark &amp; confidence intervals</li>
        <li>How to plug risk-aware routing into existing Python/TS agent pipelines</li>
        <li>Syllabus-grounded AI workflows for university courses</li>
      </ul>
    </div>
    <form class="lead-form" method="post" action="/api/leads" data-lead-form data-audience="power-user">
      <input class="sr" type="text" name="website_url" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="source_page" value="/guides">
      <input type="hidden" name="utm_source" value="">
      <input type="hidden" name="utm_medium" value="">
      <input type="hidden" name="utm_campaign" value="">
      <label>Work or academic email
        <input type="email" name="email" required autocomplete="email" placeholder="you@company.com">
      </label>
      <div class="lead-row">
        <label>Optional SMS updates
          <input type="tel" name="phone" autocomplete="tel" placeholder="+1 (555) 000-0000">
        </label>
        <label>Primary focus
          <select name="audience">
            <option value="power-user">AI Power User / Professional</option>
            <option value="api">Developer / Agent APIs</option>
            <option value="educator">Professor / Higher Ed</option>
          </select>
        </label>
      </div>
      <button class="btn primary" type="submit">Send me the technical brief</button>
      <p class="lead-status" data-lead-status role="status" aria-live="polite" hidden></p>
    </form>
  </section>
</main>

<footer>
  <span>© 2026 Harrat Global Holdings, Inc.</span>
  <nav aria-label="Legal and help"><a href="/">Eden</a><a href="/accuracy">Accuracy</a><a href="/edu">Education</a><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</footer>
</body>
</html>
`;
}

// Write Hub
const guidesDir = path.join(PUBLIC, 'guides');
fs.mkdirSync(guidesDir, { recursive: true });
fs.writeFileSync(path.join(guidesDir, 'index.html'), renderHub(), 'utf8');

// Write Case Studies
for (const cs of CASE_STUDIES) {
  const detail = CONTENT[cs.slug];
  if (!detail) throw new Error(`Missing content for case study: ${cs.slug}`);
  const outDir = path.join(PUBLIC, 'case-studies', cs.slug);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage({ meta: cs, detail, isCaseStudy: true }), 'utf8');
}

// Write Guides
for (const g of GUIDES) {
  const detail = CONTENT[g.slug];
  if (!detail) throw new Error(`Missing content for guide: ${g.slug}`);
  const outDir = path.join(PUBLIC, 'guides', g.slug);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage({ meta: g, detail, isCaseStudy: false }), 'utf8');
}

console.log(`Built /guides hub, ${CASE_STUDIES.length} case study, and ${GUIDES.length} SEO guides.`);
