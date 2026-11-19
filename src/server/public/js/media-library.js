(() => {
  const el = id => document.getElementById(id);
  const names = new Map();
  let offset = 0, busy = false, searchRun = 0, detailRun = 0;
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const message = text => { el('library-message').textContent = text; };
  async function api(url, body) {
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 401) { window.location.assign('/login'); throw new Error('Please sign in'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }
  function button(text, action, style = 'btn btn-outline-primary btn-sm') {
    const b = node('button', text, style); b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await action(); } catch (error) { message(error.message); }
      finally { b.disabled = false; }
    }); return b;
  }
  function endpoint(item) { return `/api/providers/${encodeURIComponent(item.providerId)}/items/${encodeURIComponent(item.id)}`; }
  async function enqueue(item, play, version) {
    await api('/api/playback/queue', { providerId: item.providerId, itemId: item.id, play, ...(version ? { mediaSourceId: version } : {}) });
    message(`${item.title} added to the queue${play ? '; playback requested' : ''}.`); await refreshQueue();
  }
  function actions(item, parent, version) {
    const row = node('div', undefined, 'd-flex flex-wrap gap-2 my-2');
    row.append(button('Play', () => enqueue(item, true, version?.value), 'btn btn-primary btn-sm'), button('Add to queue', () => enqueue(item, false, version?.value)));
    parent.append(row);
  }
  async function details(item) {
    const run = ++detailRun;
    const box = el('details'); box.hidden = false; box.replaceChildren(node('p', 'Loading details…'));
    const data = await api(endpoint(item)); if (run !== detailRun) return;
    box.replaceChildren(node('h2', data.title, 'h3'), node('p', `${names.get(data.providerId) || data.providerId} · ${data.kind}${data.year ? ` · ${data.year}` : ''}${data.durationMs ? ` · ${Math.round(data.durationMs / 60000)} min` : ''}`, 'text-muted'), node('p', data.overview || 'No description available.'));
    if (data.kind === 'movie' || data.kind === 'episode') {
      let version;
      if (data.sources?.length) {
        const label = node('label', 'Media version', 'form-label'); label.htmlFor = 'media-version';
        version = node('select', undefined, 'form-select mb-2'); version.id = 'media-version';
        for (const source of data.sources) { const option = node('option', [source.name, source.video, source.audio].filter(Boolean).join(' · ')); option.value = source.id; version.append(option); }
        box.append(label, version);
      }
      actions(data, box, version);
      box.append(node('p', 'Default audio · Subtitles off', 'small text-muted'));
    } else if (data.kind === 'series') {
      const seasons = await api(`${endpoint(data)}/seasons`); if (run !== detailRun) return;
      const list = node('div', undefined, 'd-flex flex-wrap gap-2');
      for (const season of seasons) list.append(button(season.title, () => episodes(data, season, box)));
      box.append(list);
      if (!seasons.length) box.append(node('p', 'No seasons available.'));
    }
    box.focus();
  }
  async function episodes(series, season, box) {
    const run = ++detailRun;
    box.querySelector('[data-episodes]')?.remove();
    const section = node('section', undefined, 'mt-3'); section.dataset.episodes = 'true'; section.append(node('h3', season.title, 'h5'), node('p', 'Loading episodes…')); box.append(section);
    const items = await api(`${endpoint(series)}/episodes?season=${encodeURIComponent(season.id)}`); if (run !== detailRun) return;
    section.replaceChildren(node('h3', season.title, 'h5'));
    for (const item of items) {
      const row = node('div', undefined, 'border-top py-3'); row.append(button(`${item.episodeNumber || ''}. ${item.title}`, () => details(item), 'btn btn-link text-start p-0'));
      actions(item, row); section.append(row);
    }
    if (!items.length) section.append(node('p', 'No episodes available.'));
  }
  async function search() {
    const run = ++searchRun; message('Loading library…');
    const query = new URLSearchParams({ q: el('query').value, provider: el('provider').value, kind: el('kind').value, library: el('library').value, offset: String(offset), limit: '24' });
    try {
      const groups = await api(`/api/media?${query}`); if (run !== searchRun) return;
      const results = el('results'); results.replaceChildren(); let count = 0;
      for (const group of groups) for (const item of group.items) {
        count++;
        const col = node('div', undefined, 'col'); const card = node('div', undefined, 'card h-100 overflow-hidden');
        const img = node('img'); img.src = item.posterUrl; img.alt = ''; img.loading = 'lazy'; img.style = 'aspect-ratio:2/3;object-fit:cover;background:#242936'; img.addEventListener('error', () => { img.hidden = true; });
        const body = node('div', undefined, 'card-body d-flex flex-column'); body.append(node('p', names.get(item.providerId) || item.providerId, 'small text-muted mb-1'), node('h2', item.title, 'h6'), node('p', `${item.kind}${item.year ? ` · ${item.year}` : ''}`, 'small text-muted'), button('Details', () => details(item)));
        card.append(img, body); col.append(card); results.append(col);
      }
      const errors = groups.filter(group => group.error).map(group => `${names.get(group.providerId) || group.providerId}: ${group.error}`);
      message(errors.length ? errors.join(' · ') : count ? `${count} titles on this page` : 'No titles found. Try another source or search.');
      el('previous').disabled = offset === 0; el('next').disabled = !groups.some(group => offset + 24 < group.total);
      el('page-label').textContent = `Page ${offset / 24 + 1}`;
    } catch (error) { if (run === searchRun) message(error.message); }
  }
  async function libraries() {
    const provider = el('provider').value;
    el('library').replaceChildren(Object.assign(node('option', 'All libraries'), { value: '' })); el('library').disabled = provider === 'all';
    if (provider !== 'all') {
      try { const rows = await api(`/api/providers/${encodeURIComponent(provider)}/libraries`); if (el('provider').value !== provider) return;
        for (const row of rows) el('library').append(Object.assign(node('option', row.title), { value: row.id }));
      } catch (error) { message(error.message); }
    }
  }
  async function refreshQueue() {
    if (busy) return; busy = true;
    try {
      const status = await api('/api/playback'); el('playback-state').textContent = status.playing ? 'Playing or preparing media' : 'Idle'; el('playback-error').textContent = status.error || '';
      el('queue').replaceChildren(...status.items.map(item => node('li', `${item.id === status.currentId ? '▶ ' : ''}${item.title} · ${item.source} · ${item.requestedBy}`, 'mb-2')));
      if (!status.items.length) el('queue').append(node('li', 'Queue is empty', 'text-muted'));
    } catch (error) { el('playback-error').textContent = error.message; }
    finally { busy = false; }
  }
  el('library-search').addEventListener('submit', event => { event.preventDefault(); offset = 0; void search(); });
  el('provider').addEventListener('change', async () => { offset = 0; await libraries(); await search(); });
  el('previous').addEventListener('click', () => { offset = Math.max(0, offset - 24); void search(); });
  el('next').addEventListener('click', () => { offset += 24; void search(); });
  document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/playback/${b.dataset.action}`, {}); await refreshQueue(); } catch (error) { message(error.message); }
    finally { b.disabled = false; }
  }));
  void (async () => {
    try {
      const providers = await api('/api/providers'); el('provider-status').replaceChildren();
      for (const provider of providers) {
        names.set(provider.id, provider.name); el('provider').append(Object.assign(node('option', `${provider.name} (${provider.kind})`), { value: provider.id }));
        const badge = node('span', `${provider.name}: ${provider.healthy ? `connected (${provider.version})` : provider.error}`, `badge text-wrap ${provider.healthy ? 'bg-success' : 'bg-danger'}`); el('provider-status').append(badge);
      }
      if (!providers.length) el('provider-status').textContent = 'No sources configured. Add a provider to MEDIA_SERVERS_CONFIG and restart.';
      await search();
    } catch (error) { message(error.message); }
  })();
  void refreshQueue(); const timer = setInterval(refreshQueue, 5000); window.addEventListener('pagehide', () => clearInterval(timer));
})();
