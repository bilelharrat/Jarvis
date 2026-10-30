// French for the Slides template library's buttons and messages in deck.js (the gallery itself takes its French from
// deck-templates-fr.js). See i18n.js.

export default {
  exact: {
    Templates: 'Modèles',
    'Start from a template…': 'Partir d’un modèle…',
    'Slide from a template…': 'Diapositive d’un modèle…',
    'Templates couldn’t load. Try again.': 'Impossible de charger les modèles. Réessayez.',
    'Template applied': 'Modèle appliqué',
    'This deck has reached its slide limit': 'Cette présentation a atteint sa limite de diapositives',
    'Slide added — click its text to edit': 'Diapositive ajoutée : cliquez sur son texte pour le modifier',
  },
  patterns: [
    [/^Started “(.+)”: click any text to make it yours$/, (_, t) => `« ${t} » est prêt : cliquez sur un texte pour l’adapter`],
    [/^Added (\d+) slides$/, (_, n) => `${n} diapositives ajoutées`],
  ],
};
