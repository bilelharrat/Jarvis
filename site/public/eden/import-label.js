// Import chats (ROADMAP Q1): the three places chats come from, their names and how to export from each,
// and which one an imported conversation came from. Pure and import-free, so the sidebar can say
// "Imported from Claude" without loading the readers (import-sources-model.js re-exports all of it).

export const SOURCES = {
  chatgpt: { label: 'ChatGPT', file: 'the .zip from ChatGPT', steps: [['In ChatGPT, open ', 'Settings › Data controls › Export data', '.'], ['ChatGPT emails you a link. Download the .zip.'], ['Drop it below. (A bare conversations.json works too.)']] },
  claude: { label: 'Claude', file: 'the .zip from Claude', steps: [['In Claude, open ', 'Settings › Privacy › Export data', '.'], ['Claude emails you a link. Download the .zip.'], ['Drop it below. (A bare conversations.json works too.) Projects become folders; memories you can review.']] },
  gemini: { label: 'Gemini', file: 'the Takeout .zip, or MyActivity.json', steps: [['Open ', 'takeout.google.com', ', choose ', 'Deselect all', ', then tick ', 'My Activity', '.'], ['Under “All activity data included”, keep only ', 'Gemini Apps', ' (JSON is best; HTML works). Export, then download the .zip.'], ['Drop the .zip or its MyActivity.json below. Google doesn’t keep which prompts were one chat: prompts less than 30 minutes apart become one.']] },
};

/** Which source an imported conversation came from ('' for Eden's own). */
export const importSource = (c) => (c && (c.source === 'chatgpt' || c.source === 'claude' || c.source === 'gemini') ? c.source : '');
export const importLabel = (c) => { const s = importSource(c); return s ? SOURCES[s].label : ''; };
