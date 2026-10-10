// French for the calendar (calendar.js, calendar-model.js, calendar-rules.js), the brief and
// meeting prep (brief.js), background tasks (tasks.js), workflows (workflows.js,
// workflow-model.js) and the spending autopilot (autopilot.js, autopilot-model.js). See i18n.js.
// No imports here: this file loads during i18n.js's top-level await.

const NB = ' '; // before : ; ! ? and inside « »

/* ----- small pieces the patterns put back together ----- */

const UNIT = { minute: ['minute', 'minutes'], hour: ['heure', 'heures'], day: ['jour', 'jours'], week: ['semaine', 'semaines'] };
/** "10 minutes before" / "At time of event" / "10 minutes (email)" (alertText and the lists built from it). */
function alertFr(s) {
  const x = String(s).trim();
  if (x === 'At time of event') return 'À l’heure de l’événement';
  if (x === 'none') return 'aucune';
  const m = /^(\d+) (minute|hour|day|week)s?( before)?( \(email\))?$/.exec(x);
  if (!m) return x;
  const n = Number(m[1]);
  return `${n} ${UNIT[m[2]][n === 1 ? 0 : 1]}${m[3] ? ' avant' : ''}${m[4] ? ' (e-mail)' : ''}`;
}
/** "10 minutes, 1 hour before" → "10 minutes, 1 heure avant". */
const alertListFr = (s) => String(s).split(', ').map(alertFr).join(', ');
const ALERT_ITEM = '(?:At time of event|\\d+ (?:minute|hour|day|week)s?(?: before)?)(?: \\(email\\))?';
const ALERT_LIST = new RegExp(`^${ALERT_ITEM}(?:, ${ALERT_ITEM})*$`);

const ACTIONS = { 'Tell me': 'Me prévenir', 'Write Gmail drafts': 'Écrire des brouillons Gmail', 'Ask me to send them': 'Me demander avant de les envoyer', 'Ask me to add events': 'Me demander avant d’ajouter des événements' };
const REPEATS = { 'Every hour': 'Toutes les heures', 'Every day': 'Tous les jours', Weekdays: 'En semaine', 'Every week': 'Toutes les semaines', Once: 'Une fois' };
const OUTCOMES = { Acted: 'Action faite', 'Nothing to do': 'Rien à faire', Skipped: 'Ignorée', 'Didn’t work': 'Échec' };
const LEVELS = { 'Max efficiency': 'Efficacité maximale', Efficient: 'Efficace', Balanced: 'Équilibré', Performance: 'Performance', 'Max performance': 'Performance maximale' };
const VERBS = { 'Add event': 'Ajouter l’événement', 'Save changes': 'Enregistrer les modifications', 'Delete event': 'Supprimer l’événement' };
const SEND_LABELS = { 'Send invitations to the guests': 'Envoyer les invitations aux invités', 'Email the guests about the change': 'Informer les invités du changement par e-mail', 'Tell the guests it’s cancelled': 'Prévenir les invités de l’annulation', 'Email the guests': 'Envoyer un e-mail aux invités' };
const WHAT = {
  'routing as you set it': 'routage tel que vous l’avez réglé',
  'one level cheaper': 'un niveau moins cher',
  'two levels cheaper, and no top-tier models on API dollars': 'deux niveaux moins cher, sans modèles haut de gamme facturés en dollars d’API',
  'Level 1 and only the cheapest models': 'niveau 1 et uniquement les modèles les moins chers',
};
const STAGE_LABEL = { 'Autopilot: saving for the month': `Pilote automatique${NB}: économies pour le mois`, 'Autopilot: budget reached': `Pilote automatique${NB}: budget atteint` };
const whatFr = (w) => WHAT[w] || w;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WHAT_AGAIN = new RegExp(`^(${Object.keys(WHAT).map(esc).join('|')}) again$`);
const LEVEL_OPTION = new RegExp(`^(\\d) · (${Object.keys(LEVELS).map(esc).join('|')})$`);

/** autopilotWhy's sentences (autopilot-model.js). */
function whyFr(s) {
  const x = String(s);
  if (x === 'No monthly budget set: the autopilot is off.') return `Aucun budget mensuel${NB}: le pilote automatique est désactivé.`;
  let m = /^(\S+) of your (\S+) this month: the budget is reached, so Eden uses only the cheapest models until it renews(?: \(it renews (.+)\))?\. Pick a model for one message to go past it\.$/.exec(x);
  if (m) return `${m[1]} sur vos ${m[2]} ce mois-ci${NB}: le budget est atteint, Eden n’utilise donc que les modèles les moins chers jusqu’au renouvellement${m[3] ? ` (le ${m[3]})` : ''}. Choisissez un modèle pour un message afin de passer outre.`;
  m = /^(\S+) of your (\S+) this month; at this pace about (\S+) by the end of the month( \(your weekday pattern counted\))?(?:, so routing is (.+) to stay within it)?\.$/.exec(x);
  if (m) return `${m[1]} sur vos ${m[2]} ce mois-ci${NB}; à ce rythme, environ ${m[3]} d’ici la fin du mois${m[4] ? ' (selon vos habitudes de la semaine)' : ''}${m[5] ? `, donc routage réglé ainsi${NB}: ${whatFr(m[5])}, pour rester dans le budget` : ''}.`;
  return x;
}

function effectFr(p) {
  if (p === 'Told you') return 'Vous a prévenu';
  if (p === 'Told you (here only)') return 'Vous a prévenu (ici seulement)';
  if (p === 'Asked to send') return 'Demande d’envoi';
  if (p === 'Asked to add an event') return 'Demande d’ajout d’événement';
  const m = /^Draft to (.*)$/.exec(p);
  return m ? `Brouillon pour ${m[1]}` : p;
}

const agoFr = (s) => {
  if (s === 'just now') return 'à l’instant';
  const m = /^(\d+) (min|h) ago$/.exec(s);
  return m ? `il y a ${m[1]} ${m[2]}` : s;
};

export default {
  exact: {
    /* ---------- calendar: header and views ---------- */
    Day: 'Jour', Week: 'Semaine', Month: 'Mois', Year: 'Année', Schedule: 'Planning',
    'Day (D)': 'Jour (D)', 'Week (W)': 'Semaine (W)', 'Month (M)': 'Mois (M)', 'Year (Y)': 'Année (Y)', 'Schedule (A)': 'Planning (A)',
    View: 'Vue',
    Previous: 'Précédent', 'Previous (←)': 'Précédent (←)', Next: 'Suivant', 'Next (→)': 'Suivant (→)',
    Today: 'Aujourd’hui', 'Today (T)': 'Aujourd’hui (T)',
    'Search events': 'Rechercher des événements', 'Search events (/)': 'Rechercher des événements (/)',
    Show: 'Afficher', Calendars: 'Calendriers', Calendar: 'Calendrier', Refresh: 'Actualiser',
    'Add what this view shows to your next message': 'Ajouter le contenu de cette vue à votre prochain message',
    'Use in chat': 'Utiliser dans la discussion',
    'New event (C)': 'Nouvel événement (C)', 'New event': 'Nouvel événement', 'Edit event': 'Modifier l’événement',
    'Close calendar': 'Fermer le calendrier', 'Close · esc': 'Fermer · esc', Close: 'Fermer',
    Event: 'Événement', 'Calendar colour': 'Couleur du calendrier', 'Event colour': 'Couleur de l’événement', Colour: 'Couleur',
    'Previous month': 'Mois précédent', 'Next month': 'Mois suivant',
    'On your Mac': 'Sur votre Mac', '· On your Mac': '· Sur votre Mac', 'your Mac': 'votre Mac', '· your Mac': '· votre Mac',
    '(read-only)': '(lecture seule)',
    'Google colour': 'Couleur Google', 'Mac colour': 'Couleur Mac',
    'The calendar’s own colour (from Google)': 'La couleur propre du calendrier (depuis Google)',
    'The calendar’s own colour (from your Mac)': 'La couleur propre du calendrier (depuis votre Mac)',
    'Only in Eden, on this device': 'Uniquement dans Eden, sur cet appareil',
    // colours (Google Calendar's names, as Google Agenda says them in French)
    Lavender: 'Lavande', Sage: 'Sauge', Grape: 'Raisin', Flamingo: 'Flamant rose', Banana: 'Banane', Tangerine: 'Mandarine',
    Peacock: 'Paon', Graphite: 'Graphite', Blueberry: 'Myrtille', Basil: 'Basilic', Tomato: 'Tomate',
    Blue: 'Bleu', Green: 'Vert', Yellow: 'Jaune', Orange: 'Orange', Red: 'Rouge', Pink: 'Rose', Purple: 'Violet', Indigo: 'Indigo', Teal: 'Turquoise', Brown: 'Marron',

    /* ----- connecting ----- */
    'Your Mac isn’t connected': 'Votre Mac n’est pas connecté',
    'Open the Jarvis app on your Mac.': 'Ouvrez l’app Jarvis sur votre Mac.',
    'Try again': 'Réessayer',
    'Couldn’t read the Mac’s calendar': 'Impossible de lire le calendrier du Mac',
    'Restart Jarvis to change these from Eden and see their colours.': 'Redémarrez Jarvis pour les modifier depuis Eden et voir leurs couleurs.',
    'Nothing in this range yet.': 'Rien sur cette période pour l’instant.',
    'Approve Eden on your Mac': 'Autorisez Eden sur votre Mac',
    'Jarvis is asking “Let Eden use Jarvis?”. Your calendars show once you allow it.': `Jarvis demande «${NB}Autoriser Eden à utiliser Jarvis${NB}?${NB}». Vos calendriers s’affichent dès que vous l’autorisez.`,
    'Jarvis is asking “Let Eden use Jarvis?”; your Mac’s calendars show once you allow it.': `Jarvis demande «${NB}Autoriser Eden à utiliser Jarvis${NB}?${NB}»${NB}; les calendriers de votre Mac s’affichent dès que vous l’autorisez.`,
    'Asking your Mac…': 'Interrogation de votre Mac…',
    'Connect Google Calendar with your Google sign-in.': 'Connectez Google Agenda avec votre compte Google.',
    'Set up Google': 'Configurer Google',
    'Sign in with Google to see your Google calendars.': 'Connectez-vous avec Google pour voir vos agendas Google.',
    'Connect Google Calendar': 'Connecter Google Agenda',
    'Reconnect Google to see your calendar': 'Reconnectez Google pour voir votre calendrier',
    'Eden now asks Google for calendar access too.': 'Eden demande désormais aussi à Google l’accès au calendrier.',
    'Reconnect Google': 'Reconnecter Google', Reconnect: 'Reconnecter',
    'Couldn’t read Google Calendar': 'Impossible de lire Google Agenda',
    'Asking Google…': 'Interrogation de Google…',
    'Couldn’t start the Google sign-in': 'Impossible de lancer la connexion Google',
    'Connect a calendar': 'Connecter un calendrier',
    'Eden shows your Mac’s calendars through the Jarvis app, and Google Calendar directly.': 'Eden affiche les calendriers de votre Mac via l’app Jarvis, et Google Agenda directement.',
    'Try the Mac again': 'Réessayer avec le Mac', 'I’ve opened Jarvis': 'J’ai ouvert Jarvis', 'Try Google again': 'Réessayer avec Google',

    /* ----- views ----- */
    'Nothing on your calendar this day.': 'Rien dans votre calendrier ce jour-là.',
    'Nothing on your calendar this week.': 'Rien dans votre calendrier cette semaine.',
    'Nothing on your calendar this month.': 'Rien dans votre calendrier ce mois-ci.',
    'Loading your calendars…': 'Chargement de vos calendriers…',
    'Drag to another day · ⌥←/⌥→ moves a day': 'Faites glisser vers un autre jour · ⌥←/⌥→ déplace d’un jour',
    'Drag to another day · ⌥←/⌥→ moves a day, ⌥↑/⌥↓ a week': 'Faites glisser vers un autre jour · ⌥←/⌥→ déplace d’un jour, ⌥↑/⌥↓ d’une semaine',
    'Drag to move · ⌥↑↓ moves, ⌥⇧↑↓ changes the length': 'Faites glisser pour déplacer · ⌥↑↓ déplace, ⌥⇧↑↓ change la durée',
    'Drag to move, drag the bottom edge to change the length · ⌥↑↓ moves, ⌥⇧↑↓ changes the length': 'Faites glisser pour déplacer, tirez le bord inférieur pour changer la durée · ⌥↑↓ déplace, ⌥⇧↑↓ change la durée',
    '(moved, press Return to review)': '(déplacé, appuyez sur Retour pour vérifier)',
    'press Return to review': 'appuyez sur Retour pour vérifier',
    '(No title)': '(Sans titre)', Untitled: 'Sans titre',
    'all-day': 'journée', less: 'moins',
    'Searching…': 'Recherche…',
    '· from 30 days ago to 60 days ahead': '· des 30 derniers jours aux 60 prochains',
    'Nothing matches. Try another word.': 'Aucun résultat. Essayez un autre mot.',
    'No events': 'Aucun événement',

    /* ----- the event popover ----- */
    'Restart Jarvis to change Mac events from Eden.': 'Redémarrez Jarvis pour modifier les événements du Mac depuis Eden.',
    'This calendar is read-only.': 'Ce calendrier est en lecture seule.',
    'Only the organizer can change this event.': 'Seul l’organisateur peut modifier cet événement.',
    'Repeats (this is one occurrence)': 'Se répète (ceci est une occurrence)', Repeats: 'Se répète',
    You: 'Vous', '· organizer': '· organisateur', '· optional': '· facultatif', '· going': '· participe', '· declined': '· refusé',
    '· maybe': '· peut-être', '· invited': '· invité', '· delegated': '· délégué', '· you': '· vous',
    'Shown as free': 'Affiché comme disponible',
    Description: 'Description', Notes: 'Notes', Attachment: 'Pièce jointe',
    'Open link': 'Ouvrir le lien', 'Join with Google Meet': 'Rejoindre avec Google Meet', 'Join call': 'Rejoindre l’appel', 'Open in Google': 'Ouvrir dans Google',
    'Going?': `Vous participez${NB}?`, 'Your answer': 'Votre réponse', Yes: 'Oui', No: 'Non', Maybe: 'Peut-être',
    'Email guests': 'Écrire aux invités', 'Delete…': 'Supprimer…', 'Edit…': 'Modifier…',
    'Going: the organizer is told': `Participation${NB}: l’organisateur est prévenu`,
    'Declined: the organizer is told': `Refusé${NB}: l’organisateur est prévenu`,
    'Maybe: the organizer is told': `Peut-être${NB}: l’organisateur est prévenu`,
    'This event': 'Cet événement', 'This and following events': 'Cet événement et les suivants', 'All events': 'Tous les événements',
    'Restart Jarvis to add Mac events from Eden, or connect Google.': 'Redémarrez Jarvis pour ajouter des événements au Mac depuis Eden, ou connectez Google.',
    'Connect a calendar you can write to first (your Mac through Jarvis, or Google).': 'Connectez d’abord un calendrier modifiable (votre Mac via Jarvis, ou Google).',

    /* ----- the editor ----- */
    'Add title': 'Ajouter un titre', Title: 'Titre', 'Time zone': 'Fuseau horaire', 'All-day': 'Toute la journée',
    'Start date': 'Date de début', 'Start time': 'Heure de début', 'End date': 'Date de fin', 'End time': 'Heure de fin',
    'Add location': 'Ajouter un lieu', Location: 'Lieu', 'Add description': 'Ajouter une description',
    'Link (https://…)': 'Lien (https://…)',
    Formatting: 'Mise en forme', Bold: 'Gras', Italic: 'Italique', Underline: 'Souligné', 'Bulleted list': 'Liste à puces',
    'Numbered list': 'Liste numérotée', Link: 'Lien', 'Clear formatting': 'Effacer la mise en forme',
    Alert: 'Alerte', 'Second alert': 'Deuxième alerte', Alerts: 'Alertes', None: 'Aucune', 'At time of event': 'À l’heure de l’événement',
    Repeat: 'Répétition', 'Repeat every': 'Répéter tous les', Unit: 'Unité', day: 'jour', week: 'semaine', month: 'mois', year: 'an',
    'Monthly on': 'Tous les mois le', 'Ends on': 'Se termine le', Occurrences: 'Occurrences', 'Repeat on': 'Répéter le',
    Ends: 'Fin', Never: 'Jamais', On: 'Le', After: 'Après', occurrences: 'occurrences', Starts: 'Début',
    'Does not repeat': 'Ne se répète pas', Daily: 'Tous les jours',
    'Every weekday (Monday to Friday)': 'Tous les jours de la semaine (du lundi au vendredi)',
    'Custom repeat (kept as it is)': 'Répétition personnalisée (conservée telle quelle)', 'Custom…': 'Personnalisé…',
    'Add guests': 'Ajouter des invités', 'Modify event': 'Modifier l’événement', 'Invite others': 'Inviter d’autres personnes',
    'See guest list': 'Voir la liste des invités', 'Mark optional': 'Marquer comme facultatif', Optional: 'Facultatif', Required: 'Obligatoire',
    'Guests can': 'Les invités peuvent', 'Find a time': 'Trouver un créneau',
    'Click a free time to move the event there': 'Cliquez sur un créneau libre pour y déplacer l’événement',
    'Calendar not shared': 'Calendrier non partagé',
    'Busy times; click a free spot to move the event': `Créneaux occupés${NB}; cliquez sur un créneau libre pour déplacer l’événement`,
    'Google Meet video conferencing': 'Visioconférence Google Meet',
    'Notification type': 'Type de notification', Notification: 'Notification', Email: 'E-mail', 'How long before': 'Combien de temps avant',
    minutes: 'minutes', hours: 'heures', days: 'jours', weeks: 'semaines', before: 'avant',
    'Remove notification': 'Supprimer la notification', 'Add notification': 'Ajouter une notification',
    Visibility: 'Visibilité', 'Default visibility': 'Visibilité par défaut', Public: 'Public', Private: 'Privé',
    'Show as': 'Afficher comme', Busy: 'Occupé', Free: 'Disponible',
    'The end must be after the start.': 'La fin doit être après le début.',
    'Pick a calendar.': 'Choisissez un calendrier.',
    'The link must start with https://.': 'Le lien doit commencer par https://.',
    'The repeat can’t end before the event starts.': 'La répétition ne peut pas se terminer avant le début de l’événement.',
    'Nothing has changed.': 'Rien n’a changé.',
    'Give the event a title.': 'Donnez un titre à l’événement.',
    'That title is too long (200 characters at most).': 'Ce titre est trop long (200 caractères au maximum).',
    'Pick the dates.': 'Choisissez les dates.',
    'The end date is before the start date.': 'La date de fin est antérieure à la date de début.',
    'An all-day event can span 31 days at most here.': 'Ici, un événement sur la journée peut couvrir 31 jours au maximum.',
    'Pick the times.': 'Choisissez les heures.',
    'A timed event can last a day at most here; make it all-day instead.': `Ici, un événement avec horaire dure une journée au maximum${NB}; faites-en plutôt un événement sur la journée.`,
    Guests: 'Invités', Meet: 'Meet', 'Add Google Meet video conferencing': 'Ajouter une visioconférence Google Meet',
    Notifications: 'Notifications', 'The calendar’s default notifications': 'Notifications par défaut du calendrier',
    'These notes are longer than Eden edits; they stay as they are.': `Ces notes sont plus longues que ce qu’Eden modifie${NB}; elles restent telles quelles.`,
    'On your Mac, Jarvis does the change; an all-day event’s days and the calendar stay as they are.': `Sur votre Mac, c’est Jarvis qui fait la modification${NB}; les jours d’un événement sur la journée et le calendrier restent inchangés.`,
    Cancel: 'Annuler', 'Review…': 'Vérifier…',

    /* ----- review and commit ----- */
    'Google Meet': 'Google Meet', 'No notifications': 'Aucune notification',
    When: 'Quand', Place: 'Lieu', old: 'ancienne', new: 'nouvelle', none: 'aucun', off: 'non', on: 'oui',
    'as they were': 'comme avant', default: 'par défaut', calendar: 'calendrier', public: 'public', private: 'privé', confidential: 'confidentiel',
    free: 'disponible', busy: 'occupé', 'Guests modify': 'Les invités modifient', 'Guests invite': 'Les invités invitent',
    'Guests see list': 'Les invités voient la liste', no: 'non', yes: 'oui', 'as they are': 'inchangées',
    'This event repeats. Change:': `Cet événement se répète. Modifier${NB}:`,
    'This event repeats. Delete:': `Cet événement se répète. Supprimer${NB}:`,
    'Every event in the series changes.': 'Tous les événements de la série changent.',
    'Add event': 'Ajouter l’événement', 'Save changes': 'Enregistrer les modifications',
    'Add this event?': `Ajouter cet événement${NB}?`, 'Save these changes?': `Enregistrer ces modifications${NB}?`,
    'Delete this event?': `Supprimer cet événement${NB}?`, 'Delete event': 'Supprimer l’événement',
    ...SEND_LABELS,
    'No one is emailed.': 'Personne ne reçoit d’e-mail.',
    'Jarvis will ask you on your Mac too': 'Jarvis vous demandera aussi sur votre Mac',
    'Deleting…': 'Suppression…', 'Saving…': 'Enregistrement…', 'Back to edit': 'Retour à la modification',
    'Approve Eden on your Mac…': 'Autorisez Eden sur votre Mac…', 'Waiting for your Mac…': 'En attente de votre Mac…',
    'You said no on your Mac, so nothing changed.': 'Vous avez refusé sur votre Mac, donc rien n’a changé.',
    'Nobody answered the card on your Mac in time, so nothing changed.': 'Personne n’a répondu à temps sur votre Mac, donc rien n’a changé.',
    'Jarvis couldn’t change the calendar.': 'Jarvis n’a pas pu modifier le calendrier.',
    'Jarvis couldn’t read the calendar.': 'Jarvis n’a pas pu lire le calendrier.',
    'Nothing that Jarvis can change has changed.': 'Rien de ce que Jarvis peut modifier n’a changé.',

    /* ---------- brief and meeting prep ---------- */
    Brief: 'Briefing', Prep: 'Préparation', 'Back to the brief': 'Retour au briefing', 'Brief settings': 'Réglages du briefing',
    'Close brief': 'Fermer le briefing', 'All day': 'Toute la journée',
    with: 'avec', until: 'jusqu’à', for: 'pour', to: 'à', due: 'échéance', 'was due': 'échéance dépassée', 'due today': 'échéance aujourd’hui',
    'This needs your Mac': 'Cela nécessite votre Mac', 'The brief didn’t load': 'Le briefing ne s’est pas chargé',
    'Eden on your Mac isn’t reachable.': 'Eden sur votre Mac est injoignable.',
    'The brief reads your calendar, mail and notes through Eden and the Jarvis app on your Mac. Open them there, then try again.': 'Le briefing lit votre calendrier, vos e-mails et vos notes via Eden et l’app Jarvis sur votre Mac. Ouvrez-les sur le Mac, puis réessayez.',
    'Your Mac': 'Votre Mac', 'Google Calendar': 'Google Agenda', 'not connected': 'non connecté', 'not set up': 'non configuré', failed: 'échec',
    'Your Mac didn’t answer fully': 'Votre Mac n’a pas tout renvoyé',
    'Notes, memory, promises and the Mac’s calendar and mail come through the Jarvis app on your Mac.': 'Les notes, la mémoire, les promesses ainsi que le calendrier et les e-mails du Mac passent par l’app Jarvis sur votre Mac.',
    'Before you go in': 'Avant d’y aller', 'Your day': 'Votre journée',
    'Picked by the router at level 1 (max efficiency)': 'Choisi par le routeur au niveau 1 (efficacité maximale)',
    'No model is available for the summary (add an API key in Settings). Everything is listed below.': 'Aucun modèle n’est disponible pour le résumé (ajoutez une clé API dans Réglages). Tout est listé ci-dessous.',
    'The summary failed.': 'Le résumé a échoué.',
    'Nothing on your calendar today.': 'Rien dans votre calendrier aujourd’hui.',
    'Mail to look at': 'E-mails à consulter', 'No unread mail that needs you.': 'Aucun e-mail non lu ne vous attend.',
    'Connect Gmail (Mail panel) or your Mac to see mail here.': 'Connectez Gmail (panneau Mail) ou votre Mac pour voir vos e-mails ici.',
    'Promises due': 'Promesses à tenir', 'Notes for today’s meetings': 'Notes pour les réunions du jour', 'About today’s people': 'Sur les personnes du jour',
    Join: 'Rejoindre', 'Recent threads with them': 'Échanges récents avec ces personnes', 'No recent email with them.': 'Aucun e-mail récent avec ces personnes.',
    'Open promises to them': 'Promesses en cours envers ces personnes', 'What Jarvis remembers': 'Ce dont Jarvis se souvient',
    'Related notes': 'Notes associées', 'Nothing related in your second brain.': 'Rien d’associé dans votre second cerveau.',
    'Open in the calendar': 'Ouvrir dans le calendrier', 'Opening…': 'Ouverture…', 'Mail said no.': 'Mail a refusé.',
    Note: 'Note', 'Open Mail': 'Ouvrir Mail', 'Open in Memory': 'Ouvrir dans Mémoire',
    'Opens on your first visit each day': 'S’ouvre à votre première visite de la journée', 'Open this every morning?': `L’ouvrir chaque matin${NB}?`,
    'Meeting prep on': 'Préparation des réunions activée', 'Meeting prep off': 'Préparation des réunions désactivée',
    'Brief and meeting prep': 'Briefing et préparation des réunions', 'Open the brief each morning': 'Ouvrir le briefing chaque matin',
    'The first time you open Eden each day.': 'La première fois que vous ouvrez Eden chaque jour.',
    'Offer meeting prep': 'Proposer la préparation des réunions',
    'Ten minutes before a meeting with other people, while Eden is open.': 'Dix minutes avant une réunion avec d’autres personnes, quand Eden est ouvert.',
    'Also tell my iPhone': 'Prévenir aussi mon iPhone',
    'A heads-up through the Jarvis app on your Mac (it reaches your phone).': 'Une alerte via l’app Jarvis sur votre Mac (elle arrive sur votre téléphone).',
    'The brief only reads: it never sends email or changes your calendar.': `Le briefing ne fait que lire${NB}: il n’envoie jamais d’e-mail et ne modifie jamais votre calendrier.`,
    'Open prep': 'Ouvrir la préparation', 'Not now': 'Pas maintenant',
    'just now': 'à l’instant',

    /* ---------- tasks ---------- */
    'New email': 'Nouvel e-mail', 'A time': 'Une heure', 'A meeting': 'Une réunion',
    ...REPEATS, ...ACTIONS, ...OUTCOMES,
    Paused: 'En pause', Ended: 'Expirée',
    approved: 'approuvée', denied: 'refusée', cancelled: 'annulée', pending: 'en attente', expired: 'expirée',
    Tasks: 'Tâches', 'Close tasks': 'Fermer les tâches', 'Couldn’t read your tasks': 'Impossible de lire vos tâches',
    'Your tasks': 'Vos tâches',
    'No tasks yet. Describe one above: “Tell me when the lawyer replies, then draft an answer.”': `Aucune tâche pour l’instant. Décrivez-en une ci-dessus${NB}: «${NB}Préviens-moi quand l’avocat répond, puis rédige une réponse.${NB}»`,
    'Loading your tasks…': 'Chargement de vos tâches…',
    'Tasks run in your askeden.com account, with your Mac off and this page closed. Each run uses a small model on your included AI, within the task’s budget. Eden writes drafts on its own; it sends email or changes your calendar only after you approve, here or from the notification on your iPhone.': `Les tâches s’exécutent dans votre compte askeden.com, Mac éteint et page fermée. Chaque exécution utilise un petit modèle de votre IA incluse, dans la limite du budget de la tâche. Eden rédige les brouillons seul${NB}; il n’envoie d’e-mail ou ne modifie votre calendrier qu’après votre accord, ici ou depuis la notification sur votre iPhone.`,
    'Tasks run while Eden is running on this Mac. Each run uses Claude Haiku (your API key or Claude Code), within the task’s budget. Eden writes drafts on its own; it sends email or changes your calendar only after you approve here. Notes reach your iPhone through Jarvis.': `Les tâches s’exécutent tant qu’Eden tourne sur ce Mac. Chaque exécution utilise Claude Haiku (votre clé API ou Claude Code), dans la limite du budget de la tâche. Eden rédige les brouillons seul${NB}; il n’envoie d’e-mail ou ne modifie votre calendrier qu’après votre accord ici. Les notes arrivent sur votre iPhone via Jarvis.`,
    'Describe a task: “Tell me when the lawyer replies, then draft an answer.”': `Décrivez une tâche${NB}: «${NB}Préviens-moi quand l’avocat répond, puis rédige une réponse.${NB}»`,
    'Describe a task': 'Décrire une tâche', 'Asking Eden…': 'Eden réfléchit…', 'Set it up': 'Configurer',
    'Describe the task in a sentence': 'Décrivez la tâche en une phrase',
    'Eden proposes the task; you check it before anything starts.': `Eden propose la tâche${NB}; vous la vérifiez avant que quoi que ce soit ne démarre.`,
    'Set up by hand': 'Configurer à la main',
    'A short name': 'Un nom court', 'Task name': 'Nom de la tâche', 'What starts it': 'Ce qui la déclenche',
    'Check every (minutes)': 'Vérifier toutes les (minutes)', 'Check every (minutes, 15 at least)': 'Vérifier toutes les (minutes, 15 au moins)',
    'Gmail search': 'Recherche Gmail', 'Email that matches (a Gmail search)': 'E-mail correspondant (une recherche Gmail)',
    'Gmail isn’t connected: connect it in Mail first, or the task waits.': `Gmail n’est pas connecté${NB}: connectez-le d’abord dans Mail, sinon la tâche attend.`,
    'acme (empty: every meeting)': `acme (vide${NB}: toutes les réunions)`,
    'Meetings matching': 'Réunions correspondant à', 'Minutes before': 'Minutes avant',
    'Google Calendar isn’t connected: connect it in Calendar first.': `Google Agenda n’est pas connecté${NB}: connectez-le d’abord dans Calendrier.`,
    'What should Eden do each time?': `Que doit faire Eden à chaque fois${NB}?`, 'What to do': 'Que faire',
    'Budget per run (dollars)': 'Budget par exécution (dollars)', 'Budget per month (dollars)': 'Budget par mois (dollars)',
    'Check this first': 'Vérifiez d’abord ceci', 'Starting…': 'Démarrage…', 'Start task': 'Démarrer la tâche',
    'Pick at least one thing Eden may do': 'Choisissez au moins une chose qu’Eden peut faire', 'Task started': 'Tâche démarrée',
    'New task': 'Nouvelle tâche', Name: 'Nom',
    'What to do (your words: the only instructions Eden follows)': `Que faire (vos mots${NB}: les seules instructions qu’Eden suit)`,
    'Eden may': 'Eden peut', 'Budget per run ($)': 'Budget par exécution ($)', 'Budget per month ($)': 'Budget par mois ($)',
    'Ends on (90 days at most)': 'Se termine le (90 jours au maximum)',
    'Sending email and changing your calendar always wait for your approval. Email the task reads is treated as data: instructions inside it are never followed.': `L’envoi d’e-mails et les modifications du calendrier attendent toujours votre accord. Les e-mails que la tâche lit sont traités comme des données${NB}: les instructions qu’ils contiennent ne sont jamais suivies.`,
    'Denied: nothing was sent': `Refusé${NB}: rien n’a été envoyé`,
    Send: 'Envoyer', 'Add to calendar': 'Ajouter au calendrier', Deny: 'Refuser',
    To: 'À', Subject: 'Objet', Message: 'Message', Where: 'Lieu',
    'Running it now': 'Exécution en cours', 'Run now': 'Exécuter maintenant', Resumed: 'Reprise', Resume: 'Reprendre',
    'Task deleted': 'Tâche supprimée', Delete: 'Supprimer', 'Not run yet.': 'Pas encore exécutée.', 'Plan and runs': 'Plan et exécutions',
    'No runs yet.': 'Aucune exécution pour l’instant.',
    'A task is waiting for you': 'Une tâche vous attend', 'Hide for now': 'Masquer pour l’instant', 'Open Tasks': 'Ouvrir Tâches',

    /* ---------- workflows ---------- */
    ...LEVELS, Chat: 'Discussion', Research: 'Recherche approfondie',
    'This browser couldn’t save the workflow (storage is full or off).': 'Ce navigateur n’a pas pu enregistrer l’automatisation (stockage plein ou désactivé).',
    Workflows: 'Automatisations', 'Close workflows': 'Fermer les automatisations',
    'Save as workflow': 'Enregistrer comme automatisation', 'Edit workflow': 'Modifier l’automatisation', 'Run on a schedule': 'Programmer',
    'No workflows yet': 'Aucune automatisation pour l’instant',
    'Open a conversation you’d like to repeat, then choose “Save as workflow” in its ⋯ menu. Eden keeps the prompt with blanks for what changes, the model and level it used, and its attachments as optional slots.': `Ouvrez une discussion que vous aimeriez refaire, puis choisissez «${NB}Enregistrer comme automatisation${NB}» dans son menu ⋯. Eden garde la requête avec des champs pour ce qui change, le modèle et le niveau utilisés, et ses pièces jointes comme emplacements facultatifs.`,
    'Save this chat as a workflow': 'Enregistrer cette discussion comme automatisation',
    Edit: 'Modifier', 'Copy recipe': 'Copier la recette', 'Share to a space…': 'Partager dans un espace…', 'Workflow deleted': 'Automatisation supprimée',
    Run: 'Exécuter',
    'Send a message first: a workflow starts from what you asked.': `Envoyez d’abord un message${NB}: une automatisation part de ce que vous avez demandé.`,
    'Workflow name': 'Nom de l’automatisation', 'Prompt with {blanks}': 'Requête avec des {champs}', Example: 'Exemple',
    'No blanks: the prompt runs as it is. Select a word above and press “Make a blank”.': `Aucun champ${NB}: la requête s’exécute telle quelle. Sélectionnez un mot ci-dessus et appuyez sur «${NB}Transformer la sélection en champ${NB}».`,
    'Make a blank of the selection': 'Transformer la sélection en champ',
    'Select the words that change from one run to the next': 'Sélectionnez les mots qui changent d’une exécution à l’autre',
    'Name this blank': 'Nommez ce champ', 'Find blanks again': 'Retrouver les champs',
    Model: 'Modèle', 'The router picks (by level)': 'Le routeur choisit (selon le niveau)', 'Router level': 'Niveau du routeur', Mode: 'Mode',
    '+ File slot': '+ Emplacement de fichier', '+ Picture slot': '+ Emplacement d’image', 'A file': 'Un fichier', 'A picture': 'Une image',
    'Saved to Workflows': 'Enregistrée dans Automatisations', 'Workflow saved': 'Automatisation enregistrée',
    Prompt: 'Requête', 'Words in {curly braces} are blanks you fill in each time.': 'Les mots entre {accolades} sont des champs à remplir à chaque fois.',
    Blanks: 'Champs', 'Used when the router picks.': 'Utilisé quand le routeur choisit.',
    'Attachments (optional each run)': 'Pièces jointes (facultatives à chaque exécution)', 'Save workflow': 'Enregistrer l’automatisation', Save: 'Enregistrer',
    Back: 'Retour', 'First run': 'Première exécution', 'Next: check the task': `Suivant${NB}: vérifier la tâche`, 'Pick when it first runs': 'Choisissez quand elle s’exécute la première fois',
    'Eden runs it in the background as a task (Tasks panel) and tells you the result. Scheduled runs use a small model within the task’s budget.': 'Eden l’exécute en arrière-plan comme une tâche (panneau Tâches) et vous donne le résultat. Les exécutions programmées utilisent un petit modèle dans la limite du budget de la tâche.',
    'Attachments aren’t used on scheduled runs.': 'Les pièces jointes ne sont pas utilisées lors des exécutions programmées.',
    'Not a workflow.': 'Ce n’est pas une automatisation.', 'Give the workflow a name.': 'Donnez un nom à l’automatisation.',
    'The prompt can’t be empty.': 'La requête ne peut pas être vide.', 'The prompt is at most 8,000 characters.': 'La requête fait 8 000 caractères au maximum.',
    'Email address': 'Adresse e-mail', Date: 'Date', 'Quoted text': 'Texte cité',

    /* ---------- spending autopilot ---------- */
    'Autopilot off for this message': 'Pilote automatique désactivé pour ce message',
    ...STAGE_LABEL,
    'Off once': 'Désactivé une fois', Autopilot: 'Pilote auto',
    'Budget reached': 'Budget atteint', 'Saving for the month': 'Économies pour le mois',
    'Let the autopilot route': 'Laisser le pilote automatique router', 'Use my level this time': 'Utiliser mon niveau cette fois',
    'Budget and spend…': 'Budget et dépenses…', 'Your included AI this month': 'Votre IA incluse ce mois-ci', 'Settings › Routing': 'Réglages › Routage',
    'Claude through your subscription is quota, not dollars: it never counts toward the budget.': `Claude via votre abonnement relève du quota, pas des dollars${NB}: il ne compte jamais dans le budget.`,
    'month end': 'fin du mois', 'Spent of the monthly budget': 'Dépensé sur le budget mensuel',
    'Loading this month…': 'Chargement du mois…', 'This month’s spend isn’t available.': 'Les dépenses de ce mois ne sont pas disponibles.',
    'Included AI this month': 'IA incluse ce mois-ci', 'This month': 'Ce mois-ci',
    'Autopilot: on track, routing as you set it': `Pilote automatique${NB}: dans les clous, routage tel que vous l’avez réglé`,
    'Your included AI isn’t known yet.': 'Votre IA incluse n’est pas encore connue.',
    'No monthly budget: the autopilot is off. Set one in Settings › Routing.': `Aucun budget mensuel${NB}: le pilote automatique est désactivé. Définissez-en un dans Réglages › Routage.`,
    'Spend this month': 'Dépenses ce mois-ci', 'This chat': 'Cette discussion', 'Open Route console →': 'Ouvrir la console de routage →',
    'Spending autopilot': 'Pilote automatique des dépenses', 'Change the budget →': 'Modifier le budget →', 'Set a monthly budget →': 'Définir un budget mensuel →',
    'On askeden.com your budget is the AI included with your account. As it runs low, Eden routes one or two levels cheaper, and once it’s used up only the cheapest model. Pick a model for one message to go past it.': 'Sur askeden.com, votre budget est l’IA incluse dans votre compte. Quand elle s’épuise, Eden route un ou deux niveaux moins cher, puis uniquement vers le modèle le moins cher une fois épuisée. Choisissez un modèle pour un message afin de passer outre.',
    'No budget': 'Aucun budget', 'Monthly budget in dollars': 'Budget mensuel en dollars', 'Your included AI is on': 'Votre IA incluse est activée',
    'No monthly budget: the autopilot is off': `Aucun budget mensuel${NB}: le pilote automatique est désactivé`,
    'Monthly budget ($)': 'Budget mensuel ($)',
    'Across your API-key providers. Claude through your subscription counts as quota, not dollars.': 'Pour l’ensemble de vos fournisseurs à clé API. Claude via votre abonnement compte comme quota, pas en dollars.',
    'At 80% of the forecast, routing goes one level cheaper; at 95%, two levels and no top-tier models billed in dollars; once the budget is spent, only the cheapest models, unless you pick a model for a message. The forecast is this month’s pace, with your weekday pattern once there are two weeks of history.': `À 80${NB}% de la prévision, le routage passe un niveau moins cher${NB}; à 95${NB}%, deux niveaux et aucun modèle haut de gamme facturé en dollars${NB}; une fois le budget dépensé, uniquement les modèles les moins chers, sauf si vous choisissez un modèle pour un message. La prévision suit le rythme du mois, avec vos habitudes de la semaine dès deux semaines d’historique.`,
    'No monthly budget set: the autopilot is off.': `Aucun budget mensuel${NB}: le pilote automatique est désactivé.`,
  },

  patterns: [
    /* ---------- calendar ---------- */
    [/^(.+), all day$/, '$1, toute la journée'],
    [/^Colour for (.+)$/, 'Couleur de $1'],
    [/^(.+)\. Open the Jarvis app on your Mac\.$/, '$1. Ouvrez l’app Jarvis sur votre Mac.'],
    [/^(\d+) calendars? couldn’t be read: (.*)$/, (m, n, why) => `${n} calendrier${n === '1' ? '' : 's'} illisible${n === '1' ? '' : 's'}${NB}: ${why}`],
    [/^Couldn’t connect Google: (.*)$/, `Impossible de connecter Google${NB}: $1`],
    [/^Mac: (.+?)\.(?: Google: (.+))?$/, (m, mac, g) => `Mac${NB}: ${mac === 'not connected' ? 'non connecté' : mac}.${g ? ` Google${NB}: ${g === 'reconnect Google to see your calendar.' ? 'reconnectez Google pour voir votre calendrier.' : g}` : ''}`],
    [/^Google: (.+)$/, (m, g) => `Google${NB}: ${g === 'reconnect Google to see your calendar.' ? 'reconnectez Google pour voir votre calendrier.' : g}`],
    [/^(\d+) more$/, '$1 de plus'],
    [/^\+(\d+) more$/, '+$1 de plus'],
    [/^(\d+) events? matching “(.*)”$/, (m, n, q) => `${n} événement${n === '1' ? '' : 's'} correspondant à «${NB}${q}${NB}»`],
    [/^Today · (.+)$/, 'Aujourd’hui · $1'],
    [/^Nothing on your calendar in the next (\d+) days\.$/, 'Rien dans votre calendrier dans les $1 prochains jours.'],
    [/^Organized by (.+)$/, 'Organisé par $1'],
    [/^(\d+) guests?((?: · \d+ (?:yes|maybe|no|awaiting))*)$/, (m, n, rest) => `${n} invité${n === '1' ? '' : 's'}${rest.replace(/(\d+) (yes|maybe|no|awaiting)/g, (x, k, w) => `${k} ${{ yes: 'oui', maybe: 'peut-être', no: 'non', awaiting: 'en attente' }[w]}`)}`],
    [/^Alerts: (.+)$/, (m, list) => `Alertes${NB}: ${alertListFr(list)}`],
    [ALERT_LIST, (m) => alertListFr(m)],
    [/^Couldn’t answer: (.*)$/, `Impossible de répondre${NB}: $1`],
    [/^Calendar: (.+)$/, `Calendrier${NB}: $1`],
    [/^Event: (.+)$/, `Événement${NB}: $1`],
    [/^Couldn’t read how it repeats: (.*)$/, `Impossible de lire la répétition${NB}: $1`],
    [/^Monthly on day (\d+)$/, (m, d) => `Tous les mois le ${d === '1' ? '1er' : d}`],
    [/^“(.*)” isn’t an email address\.$/, `«${NB}$1${NB}» n’est pas une adresse e-mail.`],
    [/^Remove (\S+@\S+)$/, 'Retirer $1'],
    [/^Find a time · (.+)$/, 'Trouver un créneau · $1'],
    [/^Couldn’t read free\/busy: (.*)$/, `Impossible de lire les disponibilités${NB}: $1`],
    [/^Google Calendar changes when you press (.+)$/, (m, v) => `Google Agenda change quand vous appuyez sur ${VERBS[v] || v}`],
    [/^Google emails the guests only if “(.+)” is ticked\.$/, (m, l) => `Google n’envoie d’e-mail aux invités que si «${NB}${SEND_LABELS[l] || l}${NB}» est coché.`],
    [/^After you press (.+?), the Jarvis app shows its own card on your Mac; the calendar changes only when you approve it there\.$/, (m, v) => `Après avoir appuyé sur ${VERBS[v] || v}, l’app Jarvis affiche sa propre demande sur votre Mac${NB}; le calendrier ne change qu’une fois que vous l’y approuvez.`],
    [/^Added “(.*)” to (.+) and invited the guests$/, `«${NB}$1${NB}» ajouté à $2 et invitations envoyées`],
    [/^Added “(.*)” to (.+) on your Mac$/, `«${NB}$1${NB}» ajouté à $2 sur votre Mac`],
    [/^Added “(.*)” to (.+)$/, `«${NB}$1${NB}» ajouté à $2`],
    [/^Saved “(.*)” \(this and following\)$/, `«${NB}$1${NB}» enregistré (celui-ci et les suivants)`],
    [/^Saved “(.*)” \(all events\)$/, `«${NB}$1${NB}» enregistré (tous les événements)`],
    [/^Saved “(.*)” on your Mac$/, `«${NB}$1${NB}» enregistré sur votre Mac`],
    [/^Saved “(.*)”$/, `«${NB}$1${NB}» enregistré`],
    [/^Deleted “(.*)” and the events after it$/, `«${NB}$1${NB}» supprimé, ainsi que les événements suivants`],
    [/^Deleted “(.*)” \(all events\)$/, `«${NB}$1${NB}» supprimé (tous les événements)`],
    [/^Deleted “(.*)” on your Mac$/, `«${NB}$1${NB}» supprimé sur votre Mac`],
    [/^Deleted “(.*)”$/, `«${NB}$1${NB}» supprimé`],

    /* ---------- brief ---------- */
    [/^Prep: (.+)$/s, `Préparation${NB}: $1`],
    [/^The summary didn’t come: (.*)$/s, `Le résumé n’est pas arrivé${NB}: $1`],
    [/^(.*?)\s*Notes, memory, promises and the Mac’s calendar and mail come through the Jarvis app on your Mac\.$/s, (m, why) => `${why ? `${why} ` : ''}Les notes, la mémoire, les promesses ainsi que le calendrier et les e-mails du Mac passent par l’app Jarvis sur votre Mac.`],
    [/^Couldn’t open it: (.*)$/s, `Impossible de l’ouvrir${NB}: $1`],
    [/^In (\d+) min$/, 'Dans $1 min'],
    [/^(\d+) (min|h) ago$/, 'il y a $1 $2'],

    /* ---------- tasks ---------- */
    [/^Email matching “(.*)”$/, `E-mail correspondant à «${NB}$1${NB}»`],
    [/^(\d+) min before meetings matching “(.*)”$/, `$1 min avant les réunions correspondant à «${NB}$2${NB}»`],
    [/^(\d+) min before each meeting$/, '$1 min avant chaque réunion'],
    [/^(Every hour|Every day|Weekdays|Every week), from (.+)$/, (m, r, w) => `${REPEATS[r]}, à partir du ${w}`],
    [/^· every (\d+) min$/, '· toutes les $1 min'],
    [/^Waiting for you \((\d+)\)$/, 'En attente de votre accord ($1)'],
    [/^Recent decisions \((\d+)\)$/, 'Décisions récentes ($1)'],
    [/^Couldn’t set it up: (.*)$/s, `Impossible de la configurer${NB}: $1`],
    [/^Couldn’t start it: (.*)$/s, `Impossible de la démarrer${NB}: $1`],
    [/^Eden’s proposal \((.+)\)$/, 'Proposition d’Eden ($1)'],
    [/^It didn’t work: (.*)$/s, `Ça n’a pas marché${NB}: $1`],
    [/^Couldn’t (approve|deny) it: (.*)$/s, (m, a, e) => `Impossible de ${a === 'approve' ? 'l’approuver' : 'la refuser'}${NB}: ${e}`],
    [/^Approval: (.+)$/s, `Approbation${NB}: $1`],
    [/^From your task “(.*)” · (.+)$/, (m, task, ago) => `De votre tâche «${NB}${task}${NB}» · ${agoFr(ago)}`],
    [/^Delete the task “(.*)”\? Its pending approvals are cancelled\.$/s, `Supprimer la tâche «${NB}$1${NB}»${NB}? Ses approbations en attente seront annulées.`],
    [/^This month (\S+) of (\S+)$/, 'Ce mois-ci $1 sur $2'],
    [/^· last run (\S+)$/, '· dernière exécution $1'],
    [/^· next (.+)$/, '· prochaine $1'],
    [/^(Acted|Nothing to do|Skipped|Didn’t work), (just now|\d+ (?:min|h) ago|.+)$/, (m, o, ago) => `${OUTCOMES[o]}, ${agoFr(ago)}`],
    [/^May: (.+?) · ends (.+?)(?: · from the workflow “(.+)”)?$/s, (m, acts, end, wf) => `Peut${NB}: ${acts.split(', ').map((a) => ACTIONS[a] || a).join(', ')} · se termine le ${end}${wf ? ` · de l’automatisation «${NB}${wf}${NB}»` : ''}`],
    [/^((?:Told you|Draft to |Asked to )[\s\S]*)$/, (m) => m.split(' · ').map(effectFr).join(' · ')],
    [/^(\d+) tasks are waiting for you$/, '$1 tâches vous attendent'],
    [/^Open Tasks \((\d+)\)$/, 'Ouvrir Tâches ($1)'],
    [/^Send “(.*)” to (.+)$/, `Envoyer «${NB}$1${NB}» à $2`],

    /* ---------- workflows ---------- */
    [/^Level (\d)$/, 'Niveau $1'],
    [/^(\d+) blanks?$/, (m, n) => `${n} champ${n === '1' ? '' : 's'}`],
    [/^(\d+) files?$/, (m, n) => `${n} fichier${n === '1' ? '' : 's'}`],
    [/^Shared in (.+?)(?: by (.+))?$/, (m, sp, by) => `Partagé dans ${sp}${by ? ` par ${by}` : ''}`],
    [/^More for (.+)$/, 'Plus pour $1'],
    [/^Couldn’t share it: (.*)$/s, `Impossible de la partager${NB}: $1`],
    [/^Delete the workflow “(.*)”\?$/s, `Supprimer l’automatisation «${NB}$1${NB}»${NB}?`],
    [/^Label for (\{.+\})$/, 'Libellé de $1'],
    [/^Example for (\{.+\})$/, 'Exemple pour $1'],
    [/^(\{.+\}) is required$/, '$1 est obligatoire'],
    [/^(.+) \(not here\)$/, '$1 (indisponible ici)'],
    [LEVEL_OPTION, (m, n, l) => `${n} · ${LEVELS[l]}`],
    [/^(A file|A picture|.+) \(optional\)$/, (m, name) => `${name === 'A file' ? 'Un fichier' : name === 'A picture' ? 'Une image' : name} (facultatif)`],
    [/^Remove the slot (.+)$/, 'Retirer l’emplacement $1'],
    [/^e\.g\. (.+)$/s, `ex.${NB}: $1`],
    [/^Fill in: (.+)$/, `À remplir${NB}: $1`],
    [/^(\S.*\.\w{1,8}) couldn’t be read\.$/, '$1 n’a pas pu être lu.'],
    [/^(.+) is over 400 KB\.$/, '$1 dépasse 400 Ko.'],
    [/^(\S.*\.\w{1,8}) isn’t a text file\.$/, '$1 n’est pas un fichier texte.'],
    [/^(.+) isn’t available here: the router picks\.$/, `$1 n’est pas disponible ici${NB}: le routeur choisit.`],
    [/^Running “(.*)”$/, `Exécution de «${NB}$1${NB}»`],
    [/^At most (\d+) blanks\.$/, '$1 champs au maximum.'],

    /* ---------- autopilot ---------- */
    [/^(.+) Tap for this message\.$/s, (m, why) => `${whyFr(why)} Touchez pour ce message.`],
    [/^(\S+) of your (\S+) this month[:;] .+$/s, (m) => whyFr(m)],
    [WHAT_AGAIN, (m, w) => `${WHAT[w]}, à nouveau`],
    [/^Level (\d) for the next message only$/, 'Niveau $1 pour le prochain message seulement'],
    [/^(\d+)% left$/, `$1${NB}% restant`],
    [/^([−-]?\$[\d.,<]+) of (\$[\d.,<]+)$/, '$1 sur $2'],
    [/^Forecast (.+?) by (.+?)( · your weekday pattern counted)?$/, (m, f, d, w) => `Prévision${NB}: ${f.replace(/^(\d+)% used$/, `$1${NB}% utilisés`)} d’ici le ${d === 'month end' ? 'la fin du mois' : d}${w ? ' · selon vos habitudes de la semaine' : ''}`.replace('d’ici le la fin', 'd’ici la fin')],
    [/^(Autopilot: saving for the month|Autopilot: budget reached): (.+)$/, (m, l, w) => `${STAGE_LABEL[l]}${NB}: ${whatFr(w)}`],
    [/^Saved vs always-(.+) this month$/, 'Économisé ce mois-ci face à $1 systématique'],
    [/^(\d+) repl(?:y|ies) billed in dollars, against (.+)’s price for the same tokens\.$/, (m, n, model) => `${n} réponse${n === '1' ? '' : 's'} facturée${n === '1' ? '' : 's'} en dollars, comparée${n === '1' ? '' : 's'} au prix de ${model} pour les mêmes jetons.`],
    [/^Claude on your subscription: (\d+) repl(?:y|ies) (?:\((\S+) at API prices\) )?counted as quota, not dollars\.$/, (m, n, usd) => `Claude via votre abonnement${NB}: ${n} réponse${n === '1' ? '' : 's'} ${usd ? `(${usd} au tarif de l’API) ` : ''}comptée${n === '1' ? '' : 's'} comme quota, pas en dollars.`],
    [/^Context window (.+)$/, 'Fenêtre de contexte $1'],
    [/^Budget: (\S+) a month$/, `Budget${NB}: $1 par mois`],
    [/^Couldn’t save the budget: (.*)$/s, `Impossible d’enregistrer le budget${NB}: $1`],
  ],
};
