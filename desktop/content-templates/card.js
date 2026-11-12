window.renderCard = async function renderCard(spec) {
  // textContent is deliberate: all member-provided content remains inert text.
  document.getElementById('card').className = `${spec.template} ${spec.accent}`;
  for (const name of ['title', 'subtitle', 'eyebrow', 'footer']) document.getElementById(name).textContent = spec[name];
  document.getElementById('page').textContent = spec.template === 'cover' ? '01' : '02';
  const list = document.getElementById('items');
  list.replaceChildren();
  for (const item of spec.items) {
    const row = document.createElement('li');
    const content = document.createElement('span');
    content.textContent = item;
    row.append(content);
    list.append(row);
  }
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const card = document.getElementById('card');
  const footer = document.querySelector('footer').getBoundingClientRect();
  const overflow = [];
  for (const id of ['eyebrow', 'title', 'subtitle', 'items', 'footer']) {
    const element = document.getElementById(id);
    if (getComputedStyle(element).display === 'none' || !element.textContent) continue;
    const rect = element.getBoundingClientRect();
    if (element.scrollWidth > element.clientWidth + 1 || rect.right > 1000 || rect.bottom > 1380 ||
      ['title', 'subtitle', 'items'].includes(id) && rect.bottom > footer.top - 20) overflow.push(id);
  }
  return { fontLoaded: document.fonts.check('30px CardCJK', '中文图文排版检查'), overflow,
    width: card.clientWidth, height: card.clientHeight };
};
