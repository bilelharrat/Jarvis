const query = new URLSearchParams(location.search);
const message = document.getElementById('message');
const note = document.getElementById('note');
const detail = document.getElementById('detail');

// In Chinese when the owner chose it (main.js passes lang=zh from Settings › General): every line main.js shows here,
// matched as it's written there (CH3-9). Names, paths, ports and the engine's own words stay as they are.
const ZH = query.get('lang') === 'zh';
const HOW = [
  [/^stopped \(exit (-?\d+|null)\)$/, (m) => `停止了（退出码 ${m[1]}）`],
  [/^was force-stopped \(SIGKILL: macOS does that when memory runs short, and so does Force Quit\)$/, () => '被强制停止（SIGKILL：内存不足时 macOS 会这样做，“强制退出”也会）'],
  [/^was asked to stop \(SIGTERM\)$/, () => '被要求停止（SIGTERM）'],
  [/^crashed \((\w+)\)$/, (m) => `崩溃了（${m[1]}）`],
  [/^was stopped \((\w+)\)$/, (m) => `被停止（${m[1]}）`],
];
const how = (text) => { for (const [re, zh] of HOW) { const m = re.exec(text); if (m) return zh(m); } return text; };
const who = (text) => (text.startsWith('The other ') ? `另一个 ${text.slice(10)}` : text);
const LINES = [
  [/^Waking up Eden…$/, () => '正在唤醒 Eden…'],
  [/^Opening (.+)…$/, (m) => `正在打开 ${m[1]}…`],
  [/^Try again$/, () => '重试'],
  [/^Still starting…$/, () => '仍在启动…'],
  [/^Still starting\. The first start after installing takes a minute or two, while Windows checks the new files\.$/, () => '仍在启动。安装后的第一次启动需要一两分钟，Windows 正在检查新文件。'],
  [/^Still starting\. Windows is still checking the files; this only happens the first time\.$/, () => '仍在启动。Windows 仍在检查这些文件；只有第一次会这样。'],
  [/^Still starting, and slower than usual\. If it never opens, (.+) says what it did\.$/, (m) => `仍在启动，比平时慢。如果一直打不开，${m[1]} 里记录了它做了什么。`],
  [/^(.+) was built from (.+), which isn’t there any more \(moved or renamed\?\)\. Build it again from where the folder is now: (npm run [\w-]+)\.$/, (m) => `${m[1]} 是从 ${m[2]} 构建的，但那个文件夹已经不在了（被移动或改名了？）。请在文件夹现在的位置重新构建：${m[3]}。`],
  [/^(.+)'s engine files are missing \((.+)\)\. Windows Security or another antivirus may have removed them\. Install (.+) again, and allow it in Windows Security if it asks\.$/, (m) => `${m[1]} 的引擎文件不见了（${m[2]}）。可能被 Windows 安全中心或其他杀毒软件删除了。请重新安装 ${m[3]}，如果 Windows 安全中心询问，请允许它。`],
  [/^(.+)'s engine files are missing from the app \((.+)\)\. Download (.+) again and replace the copy in Applications\.$/, (m) => `应用里缺少 ${m[1]} 的引擎文件（${m[2]}）。请重新下载 ${m[3]}，并替换“应用程序”文件夹里的那一份。`],
  [/^Couldn't start the backend: (.+)$/, (m) => `无法启动后端：${m[1]}`],
  [/^Another Eden backend is still using your data \(a `jarvis serve` in a terminal, or one that hasn’t finished quitting\)\. Quit it, then open Eden again\.$/, () => '另一个 Eden 后端仍在使用你的数据（终端里的 `jarvis serve`，或一个还没退出完的后端）。请先退出它，然后重新打开 Eden。'],
  [/^Another Eden backend is still using your data\. Waiting for it to finish…$/, () => '另一个 Eden 后端仍在使用你的数据。正在等它结束…'],
  [/^The backend (.+) three times in five minutes\.(?: The folder it runs from is missing: (.+)\.)? Details are in (.+)\.$/, (m) => `后端在五分钟内三次${how(m[1])}。${m[2] ? `它运行所在的文件夹不见了：${m[2]}。` : ''}详情见 ${m[3]}。`],
  [/^The backend (.+)\. Starting it again…$/, (m) => `后端${how(m[1])}。正在重新启动…`],
  [/^(.+) couldn't start again: (.+)\. Details are in (.+)\.$/, (m) => `${m[1]} 无法再次启动：${m[2]}。详情见 ${m[3]}。`],
  [/^(.+) couldn't start: (.+)\. Details are in (.+)\.$/, (m) => `${m[1]} 无法启动：${m[2]}。详情见 ${m[3]}。`],
  [/^(.+) quit, so (.+) is starting its own backend…$/, (m) => `${who(m[1])} 已退出，所以 ${m[2]} 正在启动自己的后端…`],
];
function say(text) {
  if (!ZH) return text;
  for (const [re, zh] of LINES) { const m = re.exec(text); if (m) return zh(m); }
  return text;
}
if (ZH && document.documentElement) document.documentElement.lang = 'zh';

// Eden Code's window (flavor.js) waits in Ask Eden's look, under its own name.
if (query.get('app') === 'eden-code') {
  document.body.classList.add('eden-code');
  document.title = 'Eden Code';
  message.textContent = 'Opening Eden Code…';
}
// J.A.R.V.I.S. Daredevil's: large yellow type on black from the first moment, named for a screen reader.
if (query.get('app') === 'daredevil') {
  document.body.classList.add('daredevil');
  document.title = 'J.A.R.V.I.S. Daredevil';
  message.textContent = 'Opening J.A.R.V.I.S. Daredevil…';
}
// Every edition's boot-up sound, the owner's choice ("C'est, c'est, c'est énergétique !"): main.js calls this once the
// window is on screen and the sound is on in Settings. Never when it starts hidden at sign-in (quiet) or when the page
// is a problem being reported.
let bootSoundPlayed = false;
window.playBootSound = () => {
  if (bootSoundPlayed || query.get('quiet') || query.get('error') || typeof Audio !== 'function') return;
  bootSoundPlayed = true;
  const sound = new Audio('daredevil-open.wav');
  sound.play().catch(() => {}); // (no sound device: nothing to say)
};
const error = query.get('error');
if (error) {
  message.textContent = error;
  // A notice of what happens next (kind=info: "Starting it again…", the other app quit) is said as the waiting is,
  // politely and in the usual colour; only a problem is red and an alert (CH3-9).
  if (query.get('kind') !== 'info') {
    document.body.classList.add('error');
    message.setAttribute('role', 'alert');
    message.setAttribute('aria-live', 'assertive');
  }
  const last = query.get('detail');
  if (last) {
    detail.textContent = last;
    detail.hidden = false;
  }
  // After the backend stopped three times (main.js restartBackend): a way to start it again without quitting the app.
  const retry = document.getElementById('retry');
  const app = typeof window.jarvisApp === 'object' && window.jarvisApp ? window.jarvisApp.feature : null;
  if (retry && query.get('retry') === '1' && app && typeof app.send === 'function') {
    retry.hidden = false;
    if (ZH) retry.textContent = say('Try again');
    retry.addEventListener('click', () => {
      retry.disabled = true;
      app.send('feature:app:retry');
    });
  }
}

// A line under the message while the engine takes its time (main.js waitForBackend).
window.sayWhileWaiting = (text) => { note.textContent = say(String(text || '')); };
if (ZH) message.textContent = say(message.textContent);
