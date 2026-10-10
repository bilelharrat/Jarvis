// French for the apps page, /download and /jarvis (public/jarvis/index.html). See site-i18n.js.
// What you say to J.A.R.V.I.S. stays in English: that's the language the app listens for.
const winMeta = (v, mb) => `Version ${v} · ${mb ? `${mb} Mo · ` : ''}Windows 10 ou 11, 64 bits · bêta, pas encore signée : si Windows affiche « Windows a protégé votre ordinateur », choisissez Informations complémentaires, puis Exécuter quand même.`;
SiteI18n.add({
  title: 'Eden : Eden Code et J.A.R.V.I.S. pour Mac et Windows',
  description: 'Deux apps signées Eden. Eden Code planifie, construit et corrige dans vos projets. J.A.R.V.I.S. pilote votre ordinateur à la voix, et inclut Eden Code. Téléchargez-les pour Mac et Windows.',
  exact: {
    'Skip to the downloads': 'Aller aux téléchargements',
    'Site': 'Site',
    'Eden home': 'Accueil Eden',
    'Download': 'Télécharger',
    'Sign in to Eden': 'Se connecter à Eden',
    'Two apps from Eden': 'Deux apps signées Eden',
    'Your code, built with you.': 'Votre code, construit avec vous.',
    'Your computer at your word.': 'Votre ordinateur à votre service.',
    'Eden Code plans, edits, runs and explains in your own projects. J.A.R.V.I.S. runs your computer by voice, and comes with Eden Code. For Mac and Windows.':
      'Eden Code planifie, modifie, exécute et explique dans vos propres projets. J.A.R.V.I.S. pilote votre ordinateur à la voix, et inclut Eden Code. Pour Mac et Windows.',
    'Eden, the chat: one conversation for every model, in your browser.': 'Eden, la discussion : une seule conversation pour tous les modèles, dans votre navigateur.',
    'A coding agent for your projects: it plans, edits, runs your tests and explains, and asks before anything risky.':
      'Un agent de programmation pour vos projets : il planifie, modifie, lance vos tests et explique, et demande avant toute action risquée.',
    'Download for Mac': 'Télécharger pour Mac',
    'Download for Windows': 'Télécharger pour Windows',
    'Mac: Apple silicon · macOS 14 or later. Windows: 10 or 11, 64-bit (beta, not signed yet). Also comes with J.A.R.V.I.S.':
      'Mac : puce Apple · macOS 14 ou version ultérieure. Windows : 10 ou 11, 64 bits (bêta, pas encore signée). Également inclus avec J.A.R.V.I.S.',
    'A voice assistant for your computer. Say what you need: your calendar and mail, the web and your files (and, on a Mac, your messages). Eden Code comes with it.':
      'Un assistant vocal pour votre ordinateur. Dites ce dont vous avez besoin : votre calendrier et vos e-mails, le web et vos fichiers (et, sur un Mac, vos messages). Eden Code est inclus.',
    'Get it for iPhone': 'Obtenir pour iPhone',
    'Version 0.1.1 · 305 MB · Apple silicon · macOS 14 or later': 'Version 0.1.1 · 305 Mo · puce Apple · macOS 14 ou version ultérieure',
    'Windows 10 or 11, 64-bit · beta, not signed yet': 'Windows 10 ou 11, 64 bits · bêta, pas encore signée',
    'For Windows · beta': 'Pour Windows · bêta',
    'J.A.R.V.I.S. for people who are blind or have low vision. Talk to it, or use only the keyboard. It works with NVDA, JAWS and Narrator, and shows large yellow type on black.':
      'J.A.R.V.I.S. pour les personnes aveugles ou malvoyantes. Parlez-lui, ou utilisez uniquement le clavier. Il fonctionne avec NVDA, JAWS et le Narrateur, et affiche de grands caractères jaunes sur fond noir.',
    'Reads your email and writes it as you dictate, in Outlook, in your own signature and font. You can say the punctuation.':
      'Lit vos e-mails et les écrit sous votre dictée, dans Outlook, avec votre signature et votre police. Vous pouvez dicter la ponctuation.',
    'Reads documents, PDFs, scans and photos aloud, a part at a time, and describes pictures.':
      'Lit à voix haute documents, PDF, numérisations et photos, une partie à la fois, et décrit les images.',
    'Tells you when email that matters arrives. Calendar, reminders and your files, by voice.':
      'Vous prévient quand un e-mail important arrive. Calendrier, rappels et fichiers, à la voix.',
    'Download J.A.R.V.I.S. Daredevil for Windows': 'Télécharger J.A.R.V.I.S. Daredevil pour Windows',
    'How it works, and the quick-start guide': 'Comment ça marche, et le guide de démarrage rapide',
    'Windows 10 or 11, 64-bit · beta, not signed yet: if Windows says “Windows protected your PC”, choose More info, then Run anyway.':
      'Windows 10 ou 11, 64 bits · bêta, pas encore signée : si Windows affiche « Windows a protégé votre ordinateur », choisissez Informations complémentaires, puis Exécuter quand même.',
    'Describe the work. It does it in your project, and shows you every change.': 'Décrivez le travail. Il le fait dans votre projet, et vous montre chaque modification.',
    'Plans, then builds': 'Planifie, puis construit',
    'Plan mode first when you want it, then edits, runs and tests, with checkpoints you can rewind.':
      'D’abord le mode Plan si vous le souhaitez, puis modifications, exécution et tests, avec des points de contrôle sur lesquels revenir.',
    'Every change, reviewed': 'Chaque modification, relue',
    'Changes by hunk with line comments, a Git panel, pull requests with CI watching and fixes.':
      'Les modifications par bloc avec commentaires de ligne, un panneau Git, des pull requests avec suivi de la CI et corrections.',
    'Sees its own work': 'Voit son propre travail',
    'Starts your dev server and checks the page after each change, in its own browser.':
      'Lance votre serveur de développement et vérifie la page après chaque modification, dans son propre navigateur.',
    'Talk, type or wave. It takes it from there.': 'Parlez, tapez ou faites un geste. Il s’occupe du reste.',
    'Just talk': 'Parlez, tout simplement',
    'Say "Jarvis" from across the room, or press ⌥ Space on a Mac or Ctrl+Alt+J on Windows. It answers out loud and lets you talk over it.':
      'Dites « Jarvis » depuis l’autre bout de la pièce, ou appuyez sur ⌥ Espace sur un Mac ou Ctrl+Alt+J sur Windows. Il répond à voix haute et vous laisse l’interrompre.',
    'Your day, handled': 'Votre journée, prise en main',
    'Calendar, mail, reminders and a morning brief (messages too, on a Mac), with a card to confirm anything that sends or pays.':
      'Calendrier, e-mails, rappels et un briefing du matin (les messages aussi, sur un Mac), avec une carte pour confirmer tout ce qui envoie ou paie.',
    'Eden Code included': 'Eden Code inclus',
    'Click Code in the dock, or say "Jarvis, let\'s code": Eden Code opens on the same sessions.':
      'Cliquez sur Code dans le Dock, ou dites « Jarvis, let’s code » : Eden Code s’ouvre sur les mêmes sessions.',
    'Get them': 'Les obtenir',
    'Both for Mac and Windows; J.A.R.V.I.S. brings Eden Code with it. The Windows apps are betas and are not signed yet: Edge may say the file “isn’t commonly downloaded” (three dots, Keep, Keep anyway) and Windows may say “Windows protected your PC” the first time (More info, then Run anyway).':
      'Les deux pour Mac et Windows ; J.A.R.V.I.S. apporte Eden Code avec lui. Les apps Windows sont des bêtas et ne sont pas encore signées : Edge peut indiquer que le fichier « n’est pas fréquemment téléchargé » (trois points, Conserver, Conserver quand même) et Windows peut afficher « Windows a protégé votre ordinateur » la première fois (Informations complémentaires, puis Exécuter quand même).',
    'Downloads for each app, by system': 'Téléchargements de chaque app, par système',
    'App': 'App',
    'iPhone and iPad': 'iPhone et iPad',
    '(beta, not signed yet: on a Mac, Control-click it and choose Open the first time)': '(bêta, pas encore signée : sur un Mac, la première fois, cliquez dessus en maintenant la touche Contrôle et choisissez Ouvrir)',
    '(for people who are blind or have low vision)': '(pour les personnes aveugles ou malvoyantes)',
    'Eden Code for Mac': 'Eden Code pour Mac',
    'Eden Code for Windows': 'Eden Code pour Windows',
    'J.A.R.V.I.S. for Mac': 'J.A.R.V.I.S. pour Mac',
    'J.A.R.V.I.S. for Windows': 'J.A.R.V.I.S. pour Windows',
    'Help': 'Aide',
    'Privacy': 'Confidentialité',
    'Terms': 'Conditions',
  },
  patterns: [
    // the page's script: the latest versions and sizes
    [/^Version (\S+) · (?:(\d+) MB · )?Apple silicon · macOS 14 or later$/, (m, v, mb) => `Version ${v} · ${mb ? `${mb} Mo · ` : ''}puce Apple · macOS 14 ou version ultérieure`],
    [/^Version (\S+) · (?:(\d+) MB · )?Windows 10 or 11, 64-bit · beta, not signed yet: if Windows says “Windows protected your PC”, choose More info, then Run anyway\.$/, (m, v, mb) => winMeta(v, mb)],
  ],
});
