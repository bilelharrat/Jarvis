// Eden Slides starter templates (web only; deck-templates.js shows them). Each `deck` is a plain Eden deck
// (deck-model.js normalizeDeck): the existing layouts, themes, charts, tables and diagrams, nothing new.
// The copy is placeholder text that says what to put there; every number is sample data and says so.
// Pure data: no DOM (src/__tests__/deck-templates.test.ts normalises, renders and exports each one). Most templates use a
// style (deck-styles.js), and no two in one category share one.

import { STYLE_THEMES } from './deck-styles.js';
import { MORE_TEMPLATES } from './deck-templates-more.js';

const SAMPLE = 'Sample numbers: replace with yours.';
const b = (text, ...sub) => (sub.length ? { text, sub } : text);
const card = (badge, heading, ...bullets) => ({ badge, heading, bullets });
const items = (...pairs) => pairs.map(([label, detail]) => ({ label, detail: detail || '' }));

// ── single slides people insert into any deck ("Insert a slide from a template") ──
export const SLIDE_TEMPLATES = [
  { id: 'agenda', name: 'Agenda', slide: { layout: 'bullets', kicker: 'AGENDA', title: 'What we’ll cover today', bullets: [b('Topic one: the first thing people need to hear', 'About 5 minutes'), b('Topic two: the main part of the talk', 'About 15 minutes'), b('Topic three: what you want them to decide', 'About 5 minutes'), 'Questions'], notes: 'Keep the agenda to three or four items. Say how long each takes so people can pace themselves.' } },
  { id: 'timeline', name: 'Timeline', slide: { layout: 'diagram', kicker: 'TIMELINE', title: 'How we get there, quarter by quarter', diagram: { type: 'timeline', items: items(['Q1', 'The first milestone people will see'], ['Q2', 'What ships or changes next'], ['Q3', 'The step that depends on Q2'], ['Q4', 'Where you’ll be at the end of the year']) }, notes: 'One milestone per point. Use dates people can hold you to.' } },
  { id: 'swot', name: 'SWOT', slide: { layout: 'grid', kicker: 'SWOT ANALYSIS', title: 'Where we stand', cards: [card('STRENGTHS', 'What we do better than anyone', 'An advantage a customer would name', 'An asset that’s hard to copy'), card('WEAKNESSES', 'Where we fall short', 'A gap customers have noticed', 'Something we lack today'), card('OPPORTUNITIES', 'Openings in the market', 'A trend that favours us', 'A segment nobody serves well'), card('THREATS', 'What could hurt us', 'A competitor’s move', 'A change in rules or costs')], takeaway: 'Write the one thing this analysis means you should do next.' } },
  { id: 'team', name: 'Team grid', slide: { layout: 'grid', kicker: 'THE TEAM', title: 'Who’s doing the work', cards: [card('LEAD', 'Name Surname', 'Role and what they own', 'One line of relevant experience'), card('PRODUCT', 'Name Surname', 'Role and what they own', 'One line of relevant experience'), card('ENGINEERING', 'Name Surname', 'Role and what they own', 'One line of relevant experience'), card('OPERATIONS', 'Name Surname', 'Role and what they own', 'One line of relevant experience')] } },
  { id: 'pricing', name: 'Pricing table', slide: { layout: 'table', kicker: 'PRICING', title: 'Plans and what each includes', table: { header: ['', 'Starter', 'Team', 'Business'], rows: [['Price per month', '$0', '$12 per person', 'Talk to us'], ['Who it’s for', 'One person trying it', 'Small teams', 'Whole companies'], ['Main limit', 'Say the limit', 'Say the limit', 'Custom'], ['Support', 'Help pages', 'Email', 'A named contact']] }, notes: 'Sample prices: replace them with your real ones before you share this.' } },
  { id: 'comparison', name: 'Before and after', slide: { layout: 'two-column', kicker: 'COMPARISON', title: 'Today versus with the change', left: { heading: 'Today', bullets: ['What people put up with now', 'What it costs them in time or money', 'Where it breaks'] }, right: { heading: 'After', bullets: ['What changes for them', 'What they save', 'What they can now do'] }, takeaway: 'Say the single biggest difference in one sentence.' } },
  { id: 'kpis', name: 'Key numbers', slide: { layout: 'stats', kicker: 'KEY NUMBERS', title: 'The numbers that matter this period', stats: [{ value: '42%', label: 'The metric people care about most', delta: '+6 pts' }, { value: '1,280', label: 'A volume number (customers, users, orders)', delta: '+18%' }, { value: '$3.4M', label: 'A money number (revenue, savings)', delta: '+9%' }, { value: '4.7', label: 'A quality number (rating, NPS)' }], bullets: [SAMPLE] } },
  { id: 'bar-chart', name: 'Bar chart', slide: { layout: 'chart', kicker: 'RESULTS', title: 'Say what the chart shows in one sentence', chart: { type: 'bar', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'This year', values: [120, 160, 190, 240] }, { name: 'Last year', values: [100, 115, 130, 150] }], source: SAMPLE }, caption: 'Point out the one bar people should look at.' } },
  { id: 'process', name: 'Process', slide: { layout: 'diagram', kicker: 'HOW IT WORKS', title: 'Four steps from start to finish', diagram: { type: 'flow', items: items(['Step one', 'What starts it'], ['Step two', 'What happens next'], ['Step three', 'Where the value is created'], ['Step four', 'What the person gets at the end']) } } },
  { id: 'funnel', name: 'Funnel', slide: { layout: 'diagram', kicker: 'FUNNEL', title: 'Where people drop off', diagram: { type: 'funnel', items: items(['Visitors', '10,000 a month'], ['Sign-ups', '1,200 (12%)'], ['Active after a week', '480 (40%)'], ['Paying', '96 (20%)']) }, notes: SAMPLE } },
  { id: 'matrix', name: '2×2 matrix', slide: { layout: 'diagram', kicker: 'PRIORITIES', title: 'Effort against impact', diagram: { type: 'matrix', items: items(['Quick wins', 'High impact, low effort: do now'], ['Big bets', 'High impact, high effort: plan'], ['Fill-ins', 'Low impact, low effort: when free'], ['Skip', 'Low impact, high effort: drop']) } } },
  { id: 'org', name: 'Org chart', slide: { layout: 'diagram', kicker: 'ORGANISATION', title: 'Who reports to whom', diagram: { type: 'hierarchy', items: [{ label: 'Leader', detail: 'Name · title' }, { label: 'Team A', detail: 'Lead’s name', children: ['Role', 'Role'] }, { label: 'Team B', detail: 'Lead’s name', children: ['Role', 'Role'] }, { label: 'Team C', detail: 'Lead’s name', children: ['Role', 'Role'] }] } } },
  { id: 'roadmap', name: 'Roadmap table', slide: { layout: 'table', kicker: 'ROADMAP', title: 'Now, next, later', table: { header: ['Now (this quarter)', 'Next (next quarter)', 'Later (this year)'], rows: [['The thing in progress', 'The thing that follows', 'The bigger idea'], ['A second item', 'A second item', 'A second item'], ['A third item', 'A third item', 'A third item']] } } },
  { id: 'quote', name: 'Quote', slide: { layout: 'quote', quote: 'Paste a real customer or expert quote here: the sentence that proves your point better than you could.', by: 'Name, role, organisation' } },
  { id: 'faq', name: 'FAQ', slide: { layout: 'two-column', kicker: 'QUESTIONS', title: 'What people usually ask', left: { heading: 'The question you hear most', bullets: ['Your short, honest answer'] }, right: { heading: 'The hardest question', bullets: ['Your answer, with the caveat'] } } },
  { id: 'section', name: 'Section break', slide: { layout: 'section', title: 'Name the next part of the talk', subtitle: 'One line on why it matters' } },
  { id: 'thanks', name: 'Thank you', slide: { layout: 'title', kicker: 'THANK YOU', title: 'Questions?', subtitle: 'Your name · email@example.com · where to find the slides', notes: 'Leave this up during questions so people can copy your details.' } },
];

// a styled theme (deck-styles.js) brings its free fonts, which the frame embeds and PowerPoint names
const themeFor = (id) => ({ base: id, ...(STYLE_THEMES[id] && STYLE_THEMES[id].fonts ? { fonts: STYLE_THEMES[id].fonts } : {}) });
const deck = (title, theme, slides, motion) => ({ title, theme: typeof theme === 'string' ? themeFor(theme) : theme, ...(motion ? { motion } : {}), slides });

export const TEMPLATES = [
  {
    id: 'pitch', name: 'Startup pitch', category: 'Business', description: 'Problem, solution, market, traction, team and the ask.',
    deck: deck('Company name: pitch', 'gradient', [
      { layout: 'title', kicker: 'SEED ROUND · 2026', title: 'Company name', subtitle: 'One sentence: what you do, for whom, and why it matters now', notes: 'Say the company name and the one-line pitch. Keep it under 20 seconds.' },
      { layout: 'bullets', kicker: 'THE PROBLEM', title: 'Describe the pain in your customer’s words', bullets: [b('Who has this problem, and how often', 'Be specific: a role, a company size, a moment in their day'), 'What it costs them today in time, money or risk', 'Why the current fixes don’t work'], takeaway: 'The one sentence a customer would say about this problem.', build: 'steps' },
      { layout: 'two-column', kicker: 'THE SOLUTION', title: 'How you solve it', left: { heading: 'What it is', bullets: ['What the product does, in plain verbs', 'The moment it saves the customer'] }, right: { heading: 'Why it’s different', bullets: ['What you do that others can’t', 'Why that’s hard to copy'] } },
      { layout: 'stats', kicker: 'MARKET', title: 'How big this can get', stats: [{ value: '$12B', label: 'Total market (say how you counted it)' }, { value: '$1.8B', label: 'The part you can reach' }, { value: '$90M', label: 'What you can win in 5 years' }], bullets: [SAMPLE + ' Cite your source in the notes.'] },
      { layout: 'chart', kicker: 'TRACTION', title: 'Monthly revenue is growing every month', chart: { type: 'line', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ name: 'MRR ($K)', values: [8, 11, 15, 21, 28, 37] }], unit: 'K', source: SAMPLE }, caption: 'Say the growth rate and what drove it.', build: 'fade' },
      { layout: 'grid', kicker: 'BUSINESS MODEL', title: 'How you make money', cards: [card('PRICE', 'What a customer pays', 'Per seat, per use or flat'), card('MARGIN', 'What you keep', 'Gross margin today and at scale'), card('PAYBACK', 'How fast it pays back', 'Months to recover what it costs to win a customer')] },
      { layout: 'grid', kicker: 'TEAM', title: 'Why this team wins', cards: [card('CEO', 'Name Surname', 'The experience that makes them right for this'), card('CTO', 'Name Surname', 'What they built before'), card('ADVISOR', 'Name Surname', 'Who they open doors to')] },
      { layout: 'title', kicker: 'THE ASK', title: 'Raising $2M to reach the next milestone', subtitle: 'Say what the money buys and when you’ll get there · your email', notes: 'Be concrete: the amount, the milestone, the date.' },
    ], { transition: 'fade' }),
  },
  {
    id: 'qbr', name: 'Quarterly business review', category: 'Business', description: 'Results against goals, wins, misses and next quarter’s plan.',
    deck: deck('Q3 business review', 'executive', [
      { layout: 'title', kicker: 'QUARTERLY BUSINESS REVIEW', title: 'Q3 2026 review', subtitle: 'Team or company name · date · presenter' },
      { layout: 'stats', kicker: 'AT A GLANCE', title: 'The quarter in four numbers', stats: [{ value: '$4.2M', label: 'Revenue', delta: '+12% QoQ' }, { value: '108%', label: 'Of target' }, { value: '94%', label: 'Customer retention', delta: '+2 pts' }, { value: '31', label: 'New customers' }], bullets: [SAMPLE], build: 'steps' },
      { layout: 'chart', kicker: 'REVENUE', title: 'Revenue beat the plan in every month', chart: { type: 'bar', labels: ['Jul', 'Aug', 'Sep'], series: [{ name: 'Actual', values: [1.3, 1.4, 1.5] }, { name: 'Plan', values: [1.2, 1.3, 1.4] }], unit: 'M', source: SAMPLE }, caption: 'Name the deal or change behind the gap.' },
      { layout: 'table', kicker: 'GOALS', title: 'What we committed to and where we landed', table: { header: ['Goal', 'Target', 'Result', 'Status'], rows: [['The first goal you set', '100', '108', 'Met'], ['The second goal', '50', '41', 'Missed'], ['The third goal', 'Launch', 'Launched', 'Met'], ['The fourth goal', '20%', '22%', 'Met']] } },
      { layout: 'two-column', kicker: 'WINS AND MISSES', title: 'What went well, what didn’t', left: { heading: 'Wins', bullets: ['The biggest win and who made it happen', 'A second win', 'Something you learned that worked'] }, right: { heading: 'Misses', bullets: ['The biggest miss and why', 'What you’re changing because of it'] } },
      { layout: 'grid', kicker: 'NEXT QUARTER', title: 'Q4 priorities', cards: [card('01', 'First priority', 'What done looks like', 'Owner'), card('02', 'Second priority', 'What done looks like', 'Owner'), card('03', 'Third priority', 'What done looks like', 'Owner')], takeaway: 'The one decision you need from this room.' },
      { layout: 'bullets', kicker: 'ASKS', title: 'What we need from leadership', bullets: ['A decision, with the date you need it', 'Budget or headcount, with the reason', 'Help from another team'] },
    ], { transition: 'push', speed: 'fast' }),
  },
  {
    id: 'lecture', name: 'Lesson or lecture', category: 'Education', description: 'Learning goals, key ideas, a worked example, a check and a recap.',
    deck: deck('Lesson title', 'academic', [
      { layout: 'title', kicker: 'COURSE CODE · WEEK 3', title: 'Lesson title', subtitle: 'Your name · course name · date' },
      { layout: 'bullets', kicker: 'BY THE END OF THIS LESSON', title: 'You will be able to…', bullets: ['Explain the main idea in your own words', 'Use it to solve a typical problem', 'Spot when it doesn’t apply'], notes: 'Learning goals start with a verb students can show: explain, solve, compare.' },
      { layout: 'section', title: 'Part 1: the key idea', subtitle: 'Where it comes from and why it matters' },
      { layout: 'bullets', kicker: 'KEY IDEA', title: 'State the idea in one sentence', bullets: [b('The definition, in plain words', 'Then the formal version, if there is one'), 'A picture or analogy that makes it stick', 'A common mistake students make'], build: 'steps' },
      { layout: 'diagram', kicker: 'HOW IT WORKS', title: 'The steps, in order', diagram: { type: 'flow', items: items(['Start', 'What you’re given'], ['Step', 'The first thing you do'], ['Step', 'The next thing'], ['Result', 'What you end up with']) } },
      { layout: 'two-column', kicker: 'WORKED EXAMPLE', title: 'An example, solved step by step', left: { heading: 'The problem', bullets: ['Write the problem exactly as students will see it'] }, right: { heading: 'The solution', bullets: ['Step 1, with the reason', 'Step 2, with the reason', 'The answer, checked'] } },
      { layout: 'quote', quote: 'Check your understanding: write a question students answer on their own in two minutes.', by: 'Pause here' },
      { layout: 'bullets', kicker: 'RECAP', title: 'What to remember', bullets: ['The key idea in one line', 'The steps', 'The mistake to avoid', 'Reading or homework for next time'] },
    ], { transition: 'fade' }),
  },
  {
    id: 'kickoff', name: 'Project kickoff', category: 'Team', description: 'Goals, scope, timeline, roles, risks and how you’ll work.',
    deck: deck('Project name: kickoff', 'corporate', [
      { layout: 'title', kicker: 'PROJECT KICKOFF', title: 'Project name', subtitle: 'Sponsor · project lead · kickoff date' },
      { layout: 'bullets', kicker: 'WHY WE’RE DOING THIS', title: 'The problem this project solves', bullets: ['What’s wrong today, with a number if you have one', 'Who it affects', 'What happens if we do nothing'] },
      { layout: 'two-column', kicker: 'SCOPE', title: 'What’s in and what’s out', left: { heading: 'In scope', bullets: ['The first thing we will deliver', 'The second', 'The third'] }, right: { heading: 'Out of scope', bullets: ['Something people might expect but won’t get', 'Something saved for a later phase'] } },
      { layout: 'diagram', kicker: 'TIMELINE', title: 'Milestones', diagram: { type: 'timeline', items: items(['Week 1', 'Kickoff and plan'], ['Week 3', 'Design agreed'], ['Week 6', 'First version'], ['Week 9', 'Testing'], ['Week 10', 'Launch']) }, build: 'rise' },
      { layout: 'table', kicker: 'ROLES', title: 'Who does what', table: { header: ['Person', 'Role', 'Decides on'], rows: [['Name', 'Sponsor', 'Budget and scope'], ['Name', 'Project lead', 'Day-to-day plan'], ['Name', 'Design', 'How it looks and works'], ['Name', 'Engineering', 'How it’s built']] } },
      { layout: 'grid', kicker: 'RISKS', title: 'What could go wrong', cards: [card('HIGH', 'The biggest risk', 'How we’ll reduce it'), card('MEDIUM', 'A second risk', 'How we’ll reduce it'), card('LOW', 'A third risk', 'What we’ll watch for')] },
      { layout: 'bullets', kicker: 'HOW WE WORK', title: 'Rituals and tools', bullets: ['Weekly check-in: day, time, length', 'Where updates and decisions are written down', 'How to raise a blocker'] },
      { layout: 'section', title: 'Questions and next steps', subtitle: 'Who does what by when' },
    ]),
  },
  {
    id: 'research', name: 'Research findings', category: 'Education', description: 'Question, method, results, what they mean and the limits.',
    deck: deck('Research findings', 'mono', [
      { layout: 'title', kicker: 'RESEARCH FINDINGS', title: 'Title that states the finding', subtitle: 'Authors · lab or team · date' },
      { layout: 'bullets', kicker: 'QUESTION', title: 'What we set out to learn', bullets: ['The research question, as one sentence', 'Why it matters: the gap in what’s known', 'The hypothesis, if you had one'] },
      { layout: 'diagram', kicker: 'METHOD', title: 'How we studied it', diagram: { type: 'flow', items: items(['Sample', 'Who or what, and how many'], ['Collection', 'How the data was gathered'], ['Analysis', 'The tests or models used'], ['Checks', 'How you ruled out the obvious errors']) } },
      { layout: 'chart', kicker: 'RESULT 1', title: 'State the main result as a sentence', chart: { type: 'bar', labels: ['Group A', 'Group B', 'Group C'], series: [{ name: 'Measure', values: [34, 52, 61] }], unit: '%', source: SAMPLE }, caption: 'Give the effect size and confidence interval, not just p.' },
      { layout: 'table', kicker: 'RESULT 2', title: 'The detail behind the result', table: { header: ['Condition', 'n', 'Mean', '95% CI'], rows: [['Control', '120', '3.4', '3.1–3.7'], ['Treatment A', '118', '4.1', '3.8–4.4'], ['Treatment B', '121', '4.6', '4.3–4.9']] }, notes: SAMPLE },
      { layout: 'two-column', kicker: 'DISCUSSION', title: 'What it means, and what it doesn’t', left: { heading: 'What it means', bullets: ['The plain-language takeaway', 'Who should act on it'] }, right: { heading: 'Limits', bullets: ['What this study can’t tell us', 'Where the sample may not generalise'] } },
      { layout: 'bullets', kicker: 'NEXT', title: 'Next steps', bullets: ['The follow-up study', 'Data or code: where to find it', 'Who to contact'] },
      { layout: 'bullets', kicker: 'REFERENCES', title: 'References', bullets: ['Author, A. (year). Title. Journal or publisher.', 'Author, B. (year). Title. Journal or publisher.', 'Add each source you cite on the slides.'] },
    ]),
  },
  {
    id: 'proposal', name: 'Sales proposal', category: 'Business', description: 'The client’s goals, your approach, pricing, proof and next steps.',
    deck: deck('Proposal for Client name', 'editorial-luxe', [
      { layout: 'title', kicker: 'PROPOSAL', title: 'Proposal for Client name', subtitle: 'Prepared by your company · date' },
      { layout: 'bullets', kicker: 'WHAT WE HEARD', title: 'Your goals, in your words', bullets: ['The client’s main goal, as they said it', 'What’s in the way today', 'What success looks like for them, with a date'], notes: 'Repeat their words back. It shows you listened.' },
      { layout: 'diagram', kicker: 'OUR APPROACH', title: 'How we’ll get you there', diagram: { type: 'flow', items: items(['Discover', '2 weeks'], ['Design', '3 weeks'], ['Deliver', '6 weeks'], ['Support', 'Ongoing']) } },
      { layout: 'grid', kicker: 'WHAT YOU GET', title: 'Deliverables', cards: [card('01', 'The first deliverable', 'What it is and when'), card('02', 'The second deliverable', 'What it is and when'), card('03', 'The third deliverable', 'What it is and when')] },
      { layout: 'table', kicker: 'INVESTMENT', title: 'Options and pricing', table: { header: ['', 'Essential', 'Recommended', 'Complete'], rows: [['Scope', 'Core only', 'Core + support', 'Everything'], ['Timeline', '8 weeks', '10 weeks', '12 weeks'], ['Price', '$40,000', '$55,000', '$72,000']] }, notes: 'Sample prices: replace them before you send this.' },
      { layout: 'quote', quote: 'A short quote from a client like this one, about the result you got them.', by: 'Name, title, company' },
      { layout: 'bullets', kicker: 'NEXT STEPS', title: 'How we start', bullets: ['Agree on the option', 'Sign by a date', 'Kickoff meeting the week after'] },
    ], { transition: 'fade', speed: 'slow' }),
  },
  {
    id: 'event', name: 'Event', category: 'Events', description: 'What, when and where, the programme, speakers and how to sign up.',
    deck: deck('Event name', 'gradient', [
      { layout: 'title', kicker: 'SAVE THE DATE', title: 'Event name', subtitle: 'Date · time · venue or link' },
      { layout: 'bullets', kicker: 'WHY COME', title: 'What you’ll get out of it', bullets: ['The main reason to attend', 'Who you’ll meet', 'What you’ll take home'] },
      { layout: 'table', kicker: 'PROGRAMME', title: 'The day at a glance', table: { header: ['Time', 'Session', 'Where'], rows: [['9:00', 'Welcome and coffee', 'Main hall'], ['9:30', 'Opening talk', 'Main hall'], ['11:00', 'Workshops', 'Rooms A–C'], ['13:00', 'Lunch', 'Terrace'], ['14:00', 'Panel', 'Main hall'], ['16:00', 'Drinks', 'Terrace']] } },
      { layout: 'grid', kicker: 'SPEAKERS', title: 'Who’s speaking', cards: [card('KEYNOTE', 'Name Surname', 'Title, organisation', 'Talk title'), card('PANEL', 'Name Surname', 'Title, organisation'), card('WORKSHOP', 'Name Surname', 'Title, organisation')] },
      { layout: 'stats', kicker: 'LAST YEAR', title: 'Last year in numbers', stats: [{ value: '600', label: 'Attendees' }, { value: '24', label: 'Sessions' }, { value: '4.8/5', label: 'Average rating' }], bullets: [SAMPLE] },
      { layout: 'title', kicker: 'REGISTER', title: 'Save your place', subtitle: 'Where to register · price · deadline' },
    ], { transition: 'zoom' }),
  },
  {
    id: 'portfolio', name: 'Portfolio', category: 'Personal', description: 'Who you are, selected projects, process and how to reach you.',
    deck: deck('Your name: portfolio', 'swiss', [
      { layout: 'title', kicker: 'PORTFOLIO', title: 'Your name', subtitle: 'What you do, in one line · city · website' },
      { layout: 'bullets', kicker: 'ABOUT', title: 'A sentence about how you work', bullets: ['Years of experience and the field', 'The kind of problems you like', 'Clients or teams you’ve worked with'] },
      { layout: 'section', title: 'Selected work', subtitle: 'Three projects that show your range' },
      { layout: 'two-column', kicker: 'PROJECT 1', title: 'Project name', left: { heading: 'The brief', bullets: ['Who it was for', 'What they needed'] }, right: { heading: 'The result', bullets: ['What you made', 'A number that shows it worked'] }, notes: 'Add a picture with Picture… in the Edit tray.' },
      { layout: 'two-column', kicker: 'PROJECT 2', title: 'Project name', left: { heading: 'The brief', bullets: ['Who it was for', 'What they needed'] }, right: { heading: 'The result', bullets: ['What you made', 'A number that shows it worked'] } },
      { layout: 'diagram', kicker: 'PROCESS', title: 'How I work', diagram: { type: 'cycle', items: items(['Listen', 'Understand the goal'], ['Sketch', 'Try several ideas'], ['Build', 'Make the best one real'], ['Refine', 'Test and improve']) } },
      { layout: 'quote', quote: 'A line from a happy client about working with you.', by: 'Name, title, company' },
      { layout: 'title', kicker: 'CONTACT', title: 'Let’s work together', subtitle: 'email@example.com · website · social handle' },
    ], { transition: 'fade', speed: 'slow' }),
  },
  {
    id: 'weekly', name: 'Weekly update', category: 'Team', description: 'Done, next, blockers and one number to watch.',
    deck: deck('Weekly update', 'minimal', [
      { layout: 'title', kicker: 'WEEKLY UPDATE', title: 'Week of 24 October', subtitle: 'Team name · who’s presenting' },
      { layout: 'stats', kicker: 'THIS WEEK', title: 'The number to watch', stats: [{ value: '87%', label: 'Sprint goals done', delta: '+5 pts' }, { value: '3', label: 'Things shipped' }, { value: '1', label: 'Open blocker' }], bullets: [SAMPLE] },
      { layout: 'two-column', kicker: 'PROGRESS', title: 'Done and next', left: { heading: 'Done', bullets: ['The most important thing finished', 'Another thing finished', 'A small win'] }, right: { heading: 'Next week', bullets: ['The top priority', 'The second', 'Something you’re starting'] }, build: 'fade' },
      { layout: 'bullets', kicker: 'BLOCKERS', title: 'Where we need help', bullets: [b('The blocker, in one line', 'Who can unblock it, and by when'), 'A risk to keep an eye on'], takeaway: 'The one ask for this meeting.' },
    ]),
  },
  {
    id: 'case-study', name: 'Case study', category: 'Marketing', description: 'The customer, the challenge, what you did and the measured result.',
    deck: deck('Case study: customer name', 'executive', [
      { layout: 'title', kicker: 'CASE STUDY', title: 'How Customer name cut costs by a third', subtitle: 'Industry · size · region', notes: 'Use the result as the title. Get the customer’s OK to publish.' },
      { layout: 'bullets', kicker: 'THE CUSTOMER', title: 'Who they are', bullets: ['What they do', 'How big they are', 'Why they looked for help'] },
      { layout: 'bullets', kicker: 'THE CHALLENGE', title: 'What wasn’t working', bullets: ['The problem in their words', 'What it cost them', 'What they’d already tried'] },
      { layout: 'diagram', kicker: 'WHAT WE DID', title: 'The solution, step by step', diagram: { type: 'timeline', items: items(['Month 1', 'Set up'], ['Month 2', 'Rolled out to the first team'], ['Month 3', 'Everyone using it']) } },
      { layout: 'stats', kicker: 'THE RESULT', title: 'Measured after six months', stats: [{ value: '−33%', label: 'Operating cost' }, { value: '2×', label: 'Faster turnaround' }, { value: '98%', label: 'Staff who kept using it' }], bullets: [SAMPLE + ' Say how each was measured.'], build: 'steps' },
      { layout: 'quote', quote: 'The customer’s own words about the result.', by: 'Name, title, Customer name' },
      { layout: 'bullets', kicker: 'TRY IT', title: 'Could this work for you?', bullets: ['Who it suits best', 'How to start', 'Who to contact'] },
    ]),
  },
  {
    id: 'all-hands', name: 'All-hands', category: 'Team', description: 'Company news, results, team highlights, priorities and Q&A.',
    deck: deck('All-hands', 'gradient', [
      { layout: 'title', kicker: 'ALL-HANDS · OCTOBER', title: 'All-hands', subtitle: 'Date · hosted by' },
      { layout: 'bullets', kicker: 'AGENDA', title: 'Today', bullets: ['Company news', 'How we’re doing', 'Team highlights', 'Priorities', 'Q&A'] },
      { layout: 'stats', kicker: 'HOW WE’RE DOING', title: 'The month in numbers', stats: [{ value: '$1.2M', label: 'Revenue', delta: '+8%' }, { value: '14', label: 'New customers' }, { value: '62', label: 'People on the team', delta: '+4' }], bullets: [SAMPLE], build: 'steps' },
      { layout: 'grid', kicker: 'TEAM HIGHLIGHTS', title: 'Shout-outs', cards: [card('PRODUCT', 'What the team shipped', 'Who to thank'), card('SALES', 'A deal worth celebrating', 'Who to thank'), card('SUPPORT', 'A customer saved', 'Who to thank'), card('NEW FACES', 'Welcome', 'Names of new joiners')] },
      { layout: 'diagram', kicker: 'PRIORITIES', title: 'What matters most next', diagram: { type: 'pyramid', items: items(['Mission', 'Why we exist'], ['This year', 'The one big goal'], ['This quarter', 'Three priorities that serve it']) } },
      { layout: 'section', title: 'Q&A', subtitle: 'Ask anything. Anonymous questions: say where to post them.' },
    ], { transition: 'push' }),
  },
  {
    id: 'launch', name: 'Product launch', category: 'Marketing', description: 'What’s new, who it’s for, how it works, pricing and the launch plan.',
    deck: deck('Product name launch', 'cinema', [
      { layout: 'title', kicker: 'INTRODUCING', title: 'Product name', subtitle: 'The one-line promise · launch date' },
      { layout: 'bullets', kicker: 'WHY NOW', title: 'The problem people have today', bullets: ['What frustrates them', 'What it costs', 'Why it’s getting worse'] },
      { layout: 'grid', kicker: 'WHAT’S NEW', title: 'Three things it does', cards: [card('01', 'First feature', 'What it lets people do'), card('02', 'Second feature', 'What it lets people do'), card('03', 'Third feature', 'What it lets people do')], build: 'rise' },
      { layout: 'diagram', kicker: 'HOW IT WORKS', title: 'From sign-up to first result', diagram: { type: 'flow', items: items(['Sign up', 'In a minute'], ['Connect', 'Your existing tools'], ['Get results', 'The first win']) } },
      { layout: 'table', kicker: 'PRICING', title: 'Plans', table: { header: ['', 'Free', 'Pro'], rows: [['Price', '$0', '$15 a month'], ['For', 'Trying it out', 'Daily use'], ['Includes', 'The basics', 'Everything']] }, notes: 'Sample prices: replace them with your real ones.' },
      { layout: 'diagram', kicker: 'LAUNCH PLAN', title: 'The next six weeks', diagram: { type: 'timeline', items: items(['Week 1', 'Beta users'], ['Week 2', 'Press and blog'], ['Week 4', 'Public launch'], ['Week 6', 'First review']) } },
      { layout: 'title', kicker: 'AVAILABLE NOW', title: 'Try it today', subtitle: 'Where to get it · launch offer' },
    ], { transition: 'zoom', speed: 'fast' }),
  },
  {
    id: 'strategy', name: 'Strategy plan', category: 'Business', description: 'Where we are, where we’re going, the choices and how we’ll measure it.',
    deck: deck('Strategy 2027', 'swiss', [
      { layout: 'title', kicker: 'STRATEGY', title: 'Strategy 2027', subtitle: 'Where we’re going and how we’ll get there' },
      { layout: 'bullets', kicker: 'WHERE WE ARE', title: 'The honest starting point', bullets: ['What’s working', 'What isn’t', 'What’s changed in the market'] },
      { layout: 'quote', quote: 'Write the vision as one sentence people can repeat: where you’ll be in three years.', by: 'Our vision' },
      { layout: 'grid', kicker: 'SWOT', title: 'Where we stand', cards: [card('STRENGTHS', 'What we do best', 'An advantage customers notice'), card('WEAKNESSES', 'Where we’re behind', 'A gap to close'), card('OPPORTUNITIES', 'Openings', 'A trend that favours us'), card('THREATS', 'Risks', 'What could hurt us')] },
      { layout: 'grid', kicker: 'CHOICES', title: 'Three bets we’re making', cards: [card('BET 1', 'The first bet', 'Why we think it pays off'), card('BET 2', 'The second bet', 'Why we think it pays off'), card('BET 3', 'The third bet', 'Why we think it pays off')], takeaway: 'Say what you’re choosing not to do.' },
      { layout: 'table', kicker: 'MEASURES', title: 'How we’ll know it’s working', table: { header: ['Measure', 'Today', 'End of 2027'], rows: [['The first measure', '20%', '35%'], ['The second', '1,000', '5,000'], ['The third', '4.1', '4.6']] }, notes: SAMPLE },
      { layout: 'diagram', kicker: 'ROADMAP', title: 'The plan by half-year', diagram: { type: 'timeline', items: items(['H1 2027', 'Foundations'], ['H2 2027', 'Scale'], ['2028', 'Expand']) } },
    ], { transition: 'fade' }),
  },
  {
    id: 'board', name: 'Board meeting', category: 'Business', description: 'Highlights, financials, KPIs, risks and the decisions needed.',
    deck: deck('Board meeting', 'corporate', [
      { layout: 'title', kicker: 'BOARD MEETING · CONFIDENTIAL', title: 'Board update', subtitle: 'Date · prepared by' },
      { layout: 'bullets', kicker: 'HIGHLIGHTS', title: 'Since the last meeting', bullets: ['The most important thing that happened', 'A second highlight', 'A concern you want to flag early'] },
      { layout: 'chart', kicker: 'FINANCIALS', title: 'Revenue and costs by quarter', chart: { type: 'bar', labels: ['Q4 25', 'Q1 26', 'Q2 26', 'Q3 26'], series: [{ name: 'Revenue', values: [2.1, 2.6, 3.2, 3.9] }, { name: 'Costs', values: [2.4, 2.7, 2.9, 3.1] }], unit: 'M', source: SAMPLE }, caption: 'Say when you expect to break even.' },
      { layout: 'table', kicker: 'KPIS', title: 'Key measures against plan', table: { header: ['Measure', 'Plan', 'Actual', 'Note'], rows: [['Revenue', '$3.6M', '$3.9M', 'Ahead'], ['Burn', '$0.5M', '$0.4M', 'Below'], ['Runway', '18 mo', '20 mo', ''], ['Headcount', '60', '62', '']] }, notes: SAMPLE },
      { layout: 'grid', kicker: 'RISKS', title: 'Top risks and what we’re doing', cards: [card('RISK 1', 'Describe the risk', 'Mitigation and owner'), card('RISK 2', 'Describe the risk', 'Mitigation and owner'), card('RISK 3', 'Describe the risk', 'Mitigation and owner')] },
      { layout: 'bullets', kicker: 'DECISIONS', title: 'What we need the board to decide', bullets: [b('Decision 1', 'The options and our recommendation'), b('Decision 2', 'The options and our recommendation')] },
    ]),
  },
  {
    id: 'marketing-plan', name: 'Marketing plan', category: 'Marketing', description: 'Audience, message, channels, budget and how you’ll measure it.',
    deck: deck('Marketing plan', 'sunset', [
      { layout: 'title', kicker: 'MARKETING PLAN · H1', title: 'Marketing plan', subtitle: 'Team · period · owner' },
      { layout: 'bullets', kicker: 'GOAL', title: 'What this plan should achieve', bullets: ['The business goal, with a number', 'The marketing goal that serves it', 'The date'] },
      { layout: 'grid', kicker: 'AUDIENCE', title: 'Who we’re talking to', cards: [card('PRIMARY', 'The main audience', 'What they care about', 'Where they spend time'), card('SECONDARY', 'A second audience', 'What they care about', 'Where they spend time')] },
      { layout: 'quote', quote: 'Write the core message: the one thing you want the audience to believe.', by: 'Our message' },
      { layout: 'chart', kicker: 'CHANNELS', title: 'Where the budget goes', chart: { type: 'doughnut', labels: ['Search', 'Social', 'Events', 'Content', 'Partners'], series: [{ name: 'Budget', values: [35, 25, 15, 15, 10] }], unit: '%', source: SAMPLE } },
      { layout: 'diagram', kicker: 'FUNNEL', title: 'How we turn attention into customers', diagram: { type: 'funnel', items: items(['Reach', 'People who see us'], ['Visit', 'People who come to the site'], ['Try', 'People who sign up'], ['Buy', 'People who pay']) } },
      { layout: 'table', kicker: 'MEASURES', title: 'Targets', table: { header: ['Measure', 'Target', 'Owner'], rows: [['Site visits', '50,000 / month', 'Name'], ['Sign-ups', '2,500 / month', 'Name'], ['Cost per sign-up', '$12', 'Name']] }, notes: SAMPLE },
    ]),
  },
  {
    id: 'training', name: 'Training workshop', category: 'Education', description: 'Objectives, modules, exercises and takeaways for a hands-on session.',
    deck: deck('Workshop title', 'ocean', [
      { layout: 'title', kicker: 'WORKSHOP', title: 'Workshop title', subtitle: 'Trainer · length · what to bring' },
      { layout: 'bullets', kicker: 'OBJECTIVES', title: 'By the end, you’ll be able to…', bullets: ['Do the first skill on your own', 'Do the second skill', 'Know where to get help'] },
      { layout: 'table', kicker: 'PLAN', title: 'How the session runs', table: { header: ['Time', 'Module', 'Format'], rows: [['0:00', 'Welcome and goals', 'Talk'], ['0:15', 'Module 1', 'Demo + practice'], ['0:45', 'Module 2', 'Pairs exercise'], ['1:15', 'Break', ''], ['1:30', 'Module 3', 'Group task'], ['2:00', 'Wrap-up', 'Discussion']] } },
      { layout: 'diagram', kicker: 'MODULE 1', title: 'The method in four steps', diagram: { type: 'cycle', items: items(['Plan', ''], ['Do', ''], ['Check', ''], ['Improve', '']) } },
      { layout: 'grid', kicker: 'EXERCISE', title: 'Your turn', cards: [card('TASK', 'What to do', 'Clear instructions, step by step'), card('TIME', '15 minutes', 'Work in pairs'), card('OUTPUT', 'What to share', 'One thing that worked, one that didn’t')] },
      { layout: 'bullets', kicker: 'TAKEAWAYS', title: 'Remember', bullets: ['The key habit', 'The common mistake', 'Where to find the materials'] },
    ], { transition: 'wipe' }),
  },
  {
    id: 'onboarding', name: 'New hire onboarding', category: 'Team', description: 'Welcome, the company, first-week plan, people and tools.',
    deck: deck('Welcome to the team', 'playful', [
      { layout: 'title', kicker: 'WELCOME', title: 'Welcome to Company name', subtitle: 'Your first week · start date' },
      { layout: 'bullets', kicker: 'WHO WE ARE', title: 'What we do and why', bullets: ['The mission in one line', 'Who our customers are', 'How we make money'] },
      { layout: 'grid', kicker: 'OUR VALUES', title: 'How we work together', cards: [card('01', 'First value', 'What it looks like in practice'), card('02', 'Second value', 'What it looks like in practice'), card('03', 'Third value', 'What it looks like in practice')] },
      { layout: 'diagram', kicker: 'YOUR FIRST WEEK', title: 'Day by day', diagram: { type: 'timeline', items: items(['Mon', 'Laptop, accounts, team lunch'], ['Tue', 'Meet your buddy'], ['Wed', 'Product walkthrough'], ['Thu', 'First small task'], ['Fri', 'Check-in with your manager']) } },
      { layout: 'table', kicker: 'PEOPLE', title: 'Who to ask', table: { header: ['For', 'Ask', 'Where'], rows: [['Your work', 'Your manager', 'Name'], ['Anything at all', 'Your buddy', 'Name'], ['Accounts and laptop', 'IT', 'Channel or email'], ['Pay and leave', 'People team', 'Channel or email']] } },
      { layout: 'bullets', kicker: 'TOOLS', title: 'What you’ll use every day', bullets: ['Chat: tool name', 'Docs: tool name', 'Tasks: tool name'] },
    ]),
  },
  {
    id: 'thesis', name: 'Thesis defence', category: 'Education', description: 'Research question, literature, method, results and contribution.',
    deck: deck('Thesis title', 'paper', [
      { layout: 'title', kicker: 'THESIS DEFENCE', title: 'Thesis title', subtitle: 'Your name · supervisor · department · date' },
      { layout: 'bullets', kicker: 'MOTIVATION', title: 'Why this question matters', bullets: ['The real-world problem', 'What we don’t know yet', 'Your research question'] },
      { layout: 'two-column', kicker: 'LITERATURE', title: 'What others have found', left: { heading: 'Established', bullets: ['A key finding (Author, year)', 'Another (Author, year)'] }, right: { heading: 'The gap', bullets: ['What’s missing', 'Where your work fits'] } },
      { layout: 'diagram', kicker: 'METHOD', title: 'Research design', diagram: { type: 'flow', items: items(['Data', 'Source and size'], ['Approach', 'Model or method'], ['Validation', 'How you tested it']) } },
      { layout: 'chart', kicker: 'RESULTS', title: 'State the main result', chart: { type: 'line', labels: ['1', '2', '3', '4', '5'], series: [{ name: 'Your method', values: [0.62, 0.71, 0.78, 0.83, 0.86] }, { name: 'Baseline', values: [0.60, 0.64, 0.67, 0.69, 0.70] }], source: SAMPLE } },
      { layout: 'grid', kicker: 'CONTRIBUTION', title: 'What this thesis adds', cards: [card('1', 'First contribution', 'One line'), card('2', 'Second contribution', 'One line'), card('3', 'Third contribution', 'One line')] },
      { layout: 'bullets', kicker: 'LIMITS AND FUTURE WORK', title: 'What’s next', bullets: ['The main limitation', 'The study you’d do next'] },
      { layout: 'bullets', kicker: 'REFERENCES', title: 'References', bullets: ['Author, A. (year). Title. Journal or publisher.', 'Author, B. (year). Title. Journal or publisher.', 'Add each source you cite on the slides.'] },
    ]),
  },
  {
    id: 'budget', name: 'Budget review', category: 'Business', description: 'Spend against budget, where it went, variances and the ask.',
    deck: deck('Budget review', 'mono', [
      { layout: 'title', kicker: 'BUDGET REVIEW · FY2026', title: 'Budget review', subtitle: 'Department · period · finance partner' },
      { layout: 'stats', kicker: 'SUMMARY', title: 'Where we are against budget', stats: [{ value: '$2.4M', label: 'Budget' }, { value: '$2.1M', label: 'Spent so far' }, { value: '88%', label: 'Used, with 2 months left' }], bullets: [SAMPLE] },
      { layout: 'chart', kicker: 'BY CATEGORY', title: 'People are most of the spend', chart: { type: 'hbar', labels: ['People', 'Software', 'Travel', 'Marketing', 'Other'], series: [{ name: 'Spent ($K)', values: [1300, 380, 140, 210, 70] }], unit: 'K', source: SAMPLE } },
      { layout: 'table', kicker: 'VARIANCES', title: 'Lines that are off plan', table: { header: ['Line', 'Budget', 'Actual', 'Variance', 'Why'], rows: [['Software', '$300K', '$380K', '+$80K', 'Say why'], ['Travel', '$200K', '$140K', '−$60K', 'Say why'], ['Marketing', '$250K', '$210K', '−$40K', 'Say why']] }, notes: SAMPLE },
      { layout: 'bullets', kicker: 'NEXT YEAR', title: 'What we’re asking for', bullets: [b('The total, and the change from this year'), 'The biggest new line, and what it buys', 'What we’ll cut to pay for it'] },
    ]),
  },
  {
    id: 'book-report', name: 'Book report', category: 'Education', description: 'The book, its characters, themes, a quote and your verdict.',
    deck: deck('Book title', 'magazine', [
      { layout: 'title', kicker: 'BOOK REPORT', title: 'Book title', subtitle: 'Author · year · your name' },
      { layout: 'bullets', kicker: 'SUMMARY', title: 'What happens, without spoilers', bullets: ['Where and when it’s set', 'The main conflict', 'Why it’s worth reading'] },
      { layout: 'grid', kicker: 'CHARACTERS', title: 'Who’s who', cards: [card('MAIN', 'Character name', 'What they want'), card('RIVAL', 'Character name', 'What stands in the way'), card('ALLY', 'Character name', 'How they help')] },
      { layout: 'diagram', kicker: 'PLOT', title: 'The shape of the story', diagram: { type: 'timeline', items: items(['Beginning', ''], ['Turning point', ''], ['Climax', ''], ['Ending', '']) } },
      { layout: 'quote', quote: 'Copy the line from the book that stayed with you.', by: 'Character, chapter or page' },
      { layout: 'two-column', kicker: 'VERDICT', title: 'What I thought', left: { heading: 'Loved', bullets: ['What worked for you'] }, right: { heading: 'Less so', bullets: ['What didn’t'] }, takeaway: 'Who should read it, in one line.' },
    ], { transition: 'fade' }),
  },
  {
    id: 'science-fair', name: 'Science project', category: 'Education', description: 'Question, hypothesis, experiment, results and conclusion.',
    deck: deck('Project title', 'playful', [
      { layout: 'title', kicker: 'SCIENCE PROJECT', title: 'Ask your question as the title', subtitle: 'Your name · class · date' },
      { layout: 'bullets', kicker: 'HYPOTHESIS', title: 'What I predicted', bullets: ['If I change this…', '…then this will happen…', '…because of this reason.'], build: 'steps' },
      { layout: 'diagram', kicker: 'EXPERIMENT', title: 'What I did', diagram: { type: 'flow', items: items(['Materials', 'What you used'], ['Set up', 'How you arranged it'], ['Test', 'What you changed each time'], ['Measure', 'What you recorded']) } },
      { layout: 'chart', kicker: 'RESULTS', title: 'What I found', chart: { type: 'line', labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'], series: [{ name: 'With light', values: [2, 4, 7, 10, 14] }, { name: 'In the dark', values: [2, 2, 3, 3, 4] }], unit: 'cm', source: SAMPLE } },
      { layout: 'bullets', kicker: 'CONCLUSION', title: 'Was I right?', bullets: ['Did the results support the hypothesis?', 'What surprised you', 'What you’d do differently'] },
    ]),
  },
  {
    id: 'nonprofit', name: 'Nonprofit impact report', category: 'Marketing', description: 'Mission, the year’s impact, a story, where money went and how to help.',
    deck: deck('Impact report 2026', 'forest', [
      { layout: 'title', kicker: 'IMPACT REPORT', title: 'Our year of impact', subtitle: 'Organisation name · 2026' },
      { layout: 'quote', quote: 'State your mission in one sentence.', by: 'Our mission' },
      { layout: 'stats', kicker: 'THE YEAR IN NUMBERS', title: 'What your support made possible', stats: [{ value: '12,400', label: 'People helped' }, { value: '38', label: 'Communities reached' }, { value: '420', label: 'Volunteers' }, { value: '91¢', label: 'Of each dollar to programmes' }], bullets: [SAMPLE], build: 'steps' },
      { layout: 'two-column', kicker: 'ONE STORY', title: 'Meet someone you helped', left: { heading: 'Before', bullets: ['Their situation, with permission to share'] }, right: { heading: 'After', bullets: ['What changed for them'] } },
      { layout: 'chart', kicker: 'WHERE THE MONEY WENT', title: 'Most of every dollar goes to programmes', chart: { type: 'pie', labels: ['Programmes', 'Fundraising', 'Admin'], series: [{ name: 'Spend', values: [91, 5, 4] }], unit: '%', source: SAMPLE } },
      { layout: 'bullets', kicker: 'GET INVOLVED', title: 'How you can help', bullets: ['Give: where and how', 'Volunteer: what’s needed', 'Share: tell one person about us'] },
    ], { transition: 'fade', speed: 'slow' }),
  },
  {
    id: 'retro', name: 'Team retrospective', category: 'Team', description: 'What went well, what didn’t, what we learned and the actions.',
    deck: deck('Retrospective', 'notebook', [
      { layout: 'title', kicker: 'RETROSPECTIVE', title: 'Sprint or project name', subtitle: 'Dates covered · facilitator' },
      { layout: 'stats', kicker: 'BY THE NUMBERS', title: 'How the sprint went', stats: [{ value: '23/27', label: 'Stories done' }, { value: '2', label: 'Incidents' }, { value: '4.1/5', label: 'Team mood' }], bullets: [SAMPLE] },
      { layout: 'grid', kicker: 'REFLECTION', title: 'Keep, stop, start', cards: [card('KEEP', 'What went well', 'Something to keep doing'), card('STOP', 'What didn’t', 'Something to stop'), card('START', 'What to try', 'One experiment for next time')] },
      { layout: 'table', kicker: 'ACTIONS', title: 'Who does what', table: { header: ['Action', 'Owner', 'By'], rows: [['The first action', 'Name', 'Date'], ['The second action', 'Name', 'Date'], ['The third action', 'Name', 'Date']] } },
    ]),
  },
  {
    id: 'competitive', name: 'Competitive analysis', category: 'Business', description: 'The landscape, a feature comparison, positioning and where to win.',
    deck: deck('Competitive analysis', 'obsidian', [
      { layout: 'title', kicker: 'COMPETITIVE ANALYSIS', title: 'The market and where we fit', subtitle: 'Market or segment · date' },
      { layout: 'grid', kicker: 'THE LANDSCAPE', title: 'Who we compete with', cards: [card('LEADER', 'Competitor A', 'What they’re known for'), card('CHALLENGER', 'Competitor B', 'What they’re known for'), card('NICHE', 'Competitor C', 'What they’re known for'), card('US', 'Our company', 'What we want to be known for')] },
      { layout: 'table', kicker: 'COMPARISON', title: 'Feature by feature', table: { header: ['', 'Us', 'Competitor A', 'Competitor B'], rows: [['Price', '$', '$$$', '$$'], ['Ease of use', 'Strong', 'Medium', 'Weak'], ['Integrations', '12', '40', '8'], ['Support', 'Live chat', 'Email', 'Live chat']] }, notes: 'Sample comparison: fill in with checked facts and say when you checked.' },
      { layout: 'diagram', kicker: 'POSITIONING', title: 'Where each one sits', diagram: { type: 'matrix', items: items(['Premium, broad', 'Competitor A'], ['Premium, focused', 'Open space'], ['Low-cost, broad', 'Competitor B'], ['Low-cost, focused', 'Us']) } },
      { layout: 'bullets', kicker: 'WHERE WE WIN', title: 'Our edge', bullets: ['The customer we win most often, and why', 'The deal we lose most often, and why', 'What we’ll do about it'] },
    ]),
  },
  {
    id: 'investor-update', name: 'Investor update', category: 'Business', description: 'Headline numbers, highlights, lowlights, burn and asks.',
    deck: deck('Investor update', 'minimal', [
      { layout: 'title', kicker: 'INVESTOR UPDATE · Q3', title: 'Company name', subtitle: 'Quarter · founders' },
      { layout: 'stats', kicker: 'HEADLINES', title: 'The quarter in numbers', stats: [{ value: '$420K', label: 'ARR', delta: '+28% QoQ' }, { value: '$85K', label: 'Monthly burn' }, { value: '19 mo', label: 'Runway' }, { value: '11', label: 'Team' }], bullets: [SAMPLE] },
      { layout: 'chart', kicker: 'GROWTH', title: 'ARR by month', chart: { type: 'area', labels: ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'], series: [{ name: 'ARR ($K)', values: [250, 280, 310, 350, 390, 420] }], unit: 'K', source: SAMPLE } },
      { layout: 'two-column', kicker: 'HIGHS AND LOWS', title: 'What went well, what didn’t', left: { heading: 'Highlights', bullets: ['The biggest win', 'A second win'] }, right: { heading: 'Lowlights', bullets: ['The biggest miss, honestly', 'What you’re doing about it'] } },
      { layout: 'bullets', kicker: 'ASKS', title: 'How you can help', bullets: ['An introduction to a type of customer', 'A hire you’re looking for', 'Advice on a decision'] },
    ], { transition: 'fade' }),
  },
  {
    id: 'conference-talk', name: 'Conference talk', category: 'Events', description: 'A hook, the story, three points, a demo moment and the takeaway.',
    deck: deck('Talk title', 'swiss', [
      { layout: 'title', kicker: 'CONFERENCE NAME · 2026', title: 'A talk title that makes a promise', subtitle: 'Your name · role · @handle' },
      { layout: 'quote', quote: 'Open with a surprising fact, a question or a short story the audience will remember.', by: 'The hook' },
      { layout: 'bullets', kicker: 'ABOUT ME', title: 'Why I’m talking about this', bullets: ['What you do', 'The experience behind this talk'] },
      { layout: 'section', title: 'Point 1: name your first idea', subtitle: 'One line that sums it up' },
      { layout: 'two-column', kicker: 'POINT 1', title: 'The old way versus the new way', left: { heading: 'Old way', bullets: ['What people do now'] }, right: { heading: 'New way', bullets: ['What you suggest'] } },
      { layout: 'section', title: 'Point 2: name your second idea', subtitle: 'One line that sums it up' },
      { layout: 'chart', kicker: 'POINT 2', title: 'The evidence in one chart', chart: { type: 'bar', labels: ['Before', 'After'], series: [{ name: 'Result', values: [40, 85] }], unit: '%', source: SAMPLE } },
      { layout: 'section', title: 'Point 3: name your third idea', subtitle: 'One line that sums it up' },
      { layout: 'bullets', kicker: 'TAKEAWAY', title: 'If you remember one thing…', bullets: ['The single idea people should leave with'], takeaway: 'Say it once more, slowly.' },
      { layout: 'title', kicker: 'THANK YOU', title: 'Questions?', subtitle: 'Slides: link · @handle' },
    ], { transition: 'push', speed: 'fast' }),
  },
  {
    id: 'product-roadmap', name: 'Product roadmap', category: 'Team', description: 'Vision, themes, now/next/later and how you decide.',
    deck: deck('Product roadmap', 'swiss', [
      { layout: 'title', kicker: 'PRODUCT ROADMAP', title: 'Product roadmap', subtitle: 'Product name · period · product lead' },
      { layout: 'quote', quote: 'The product vision: what people will be able to do that they can’t today.', by: 'Where we’re heading' },
      { layout: 'grid', kicker: 'THEMES', title: 'Three themes for the year', cards: [card('THEME 1', 'First theme', 'The customer problem it solves'), card('THEME 2', 'Second theme', 'The customer problem it solves'), card('THEME 3', 'Third theme', 'The customer problem it solves')] },
      { layout: 'table', kicker: 'ROADMAP', title: 'Now, next, later', table: { header: ['Now', 'Next', 'Later'], rows: [['In progress, with a date', 'Planned, rough timing', 'Ideas, no date'], ['A second item', 'A second item', 'A second item'], ['A third item', 'A third item', 'A third item']] }, notes: 'Later items are not promises: say so out loud.' },
      { layout: 'diagram', kicker: 'HOW WE DECIDE', title: 'How an idea gets on the roadmap', diagram: { type: 'funnel', items: items(['Ideas', 'From customers and the team'], ['Evidence', 'How many people, how much it matters'], ['Fit', 'Does it serve a theme?'], ['Roadmap', 'Scheduled']) } },
    ]),
  },
];

TEMPLATES.push(...MORE_TEMPLATES);
export const TEMPLATE_CATEGORIES = ['All', ...new Set(['Business', 'Marketing', 'Education', 'Team', 'Personal', 'Events', ...TEMPLATES.map((t) => t.category)])];
