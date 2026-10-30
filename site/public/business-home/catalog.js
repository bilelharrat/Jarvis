export const categories = new Set(['all', 'work', 'build', 'learn']);

export function matchesCategory(value, category) {
  return category === 'all' || value.split(/\s+/).includes(category);
}

export const workflows = {
  day: {
    title: 'Less busywork.\nMore breathing room.',
    description: 'Make sense of an overflowing inbox, prepare for a meeting, and get a first draft out of your head.',
    products: [
      { name: 'Ask Eden', description: 'Think it through.', href: 'https://askeden.com/' },
      { name: 'Eden Mail', description: 'Find the words.', href: 'https://askeden.com/mail' },
      { name: 'Eden Secretary', description: 'Make room in your day.', href: 'https://askeden.com/eden-secretary' },
    ],
  },
  build: {
    title: 'From “what if”\nto what’s next.',
    description: 'Build in your own project, choose models for the task, and give factual answers a second look.',
    products: [
      { name: 'Eden Code', description: 'Build, test, and iterate.', href: 'https://askeden.com/eden-code' },
      { name: 'Eden Router', description: 'Choose the model that fits.', href: 'https://edenrouter.com/' },
      { name: 'EVES', description: 'Check the claims.', href: 'https://evesverification.com/' },
    ],
  },
  learn: {
    title: 'A little curiosity.\nA whole new world.',
    description: 'Explore an idea, study from your course materials, and find more accessible ways to read and work.',
    products: [
      { name: 'Eden for Education', description: 'Start with your materials.', href: 'https://askedenedu.com/' },
      { name: 'Ask Eden', description: 'Follow your curiosity.', href: 'https://askeden.com/' },
      { name: 'Eden Daredevil', description: 'Work by voice or keyboard.', href: 'https://askeden.com/daredevil' },
    ],
  },
};
