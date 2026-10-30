import { categories, matchesCategory, workflows } from './catalog.js';

const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#main-nav');

function closeMenu(returnFocus = false) {
  menuToggle.setAttribute('aria-expanded', 'false');
  nav.classList.remove('open');
  if (returnFocus) menuToggle.focus();
}

menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  nav.classList.toggle('open', open);
});
nav.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') closeMenu(true);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.site-header')) closeMenu();
});
window.matchMedia('(min-width: 641px)').addEventListener('change', () => closeMenu());

const cards = [...document.querySelectorAll('.product-card')];
const filters = [...document.querySelectorAll('[data-filter]')];
for (const button of filters) {
  button.addEventListener('click', () => {
    const category = button.dataset.filter;
    if (!categories.has(category)) return;
    for (const filter of filters) {
      const active = filter === button;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    }
    for (const card of cards) card.hidden = !matchesCategory(card.dataset.category, category);
    const count = cards.filter((card) => !card.hidden).length;
    document.querySelector('#product-count').textContent = `${count} tools. Your possibilities.`;
  });
}

for (const button of document.querySelectorAll('[data-workflow]')) {
  button.addEventListener('click', () => {
    const workflow = workflows[button.dataset.workflow];
    if (!workflow) return;
    for (const option of document.querySelectorAll('[data-workflow]')) {
      const active = option === button;
      option.classList.toggle('selected', active);
      option.setAttribute('aria-pressed', String(active));
    }
    document.querySelector('#workflow-title').textContent = workflow.title;
    document.querySelector('#workflow-description').textContent = workflow.description;
    const links = workflow.products.map((product, index) => {
      const link = document.createElement('a');
      link.href = product.href;
      const number = document.createElement('span');
      number.className = 'stack-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = product.name;
      const description = document.createElement('small');
      description.textContent = product.description;
      text.append(title, description);
      const arrow = document.createElement('span');
      arrow.textContent = '↗';
      arrow.setAttribute('aria-hidden', 'true');
      link.append(number, text, arrow);
      return link;
    });
    document.querySelector('#workflow-stack').replaceChildren(...links);
  });
}

document.querySelector('#year').textContent = new Date().getFullYear();
