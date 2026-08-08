import { api, fmtDate, humanSize, pfpUrl } from '../api.js';
import { currentRenderSeq } from '../app.js';
import { h } from '../ui.js';

export async function renderLibrary(el) {
  const seq = currentRenderSeq();
  const hero = h('div', { class: 'hero' }, [
    h('h1', { class: 'page-title' }, 'game library'),
    h('p', { class: 'sub small' }, 'offline games, always on the LAN'),
  ]);
  el.replaceChildren(hero, h('div', { id: 'lib' }));
  const box = el.querySelector('#lib');
  box.replaceChildren(h('div', { class: 'muted small flex', style: 'gap:8px;padding:12px 0;' }, [h('span', { class: 'spinner' }), h('span', { text: 'fetching library…' })]));

  const { games } = await api.games.list();
  if (currentRenderSeq() !== seq) return;
  if (!games.length) {
    box.replaceChildren(h('div', { class: 'empty' }, [
      h('p', { text: 'no games on this server yet.' }),
      h('a', { class: 'btn', href: '#/upload', text: 'upload the first one' }),
    ]));
    return;
  }
  box.replaceChildren(h('div', { class: 'grid' }, games.map(gameCard)));
}

function gameCard(g) {
  const cover = g.cover
    ? h('img', { src: g.cover, alt: g.name, loading: 'lazy' })
    : h('span', { text: '▢' });
  const size = g.status === 'ready' ? humanSize(g.total_size) : '…';
  return h('article', { class: 'card' }, [
    h('a', { href: `#/game/${g.id}`, class: 'card-cover' }, [cover]),
    h('div', { class: 'card-body' }, [
      h('div', { class: 'card-title' }, [h('a', { href: `#/game/${g.id}`, text: g.name })]),
      h('div', { class: 'card-meta' }, [
        h('span', { class: `badge badge-${g.status}`, text: g.status }),
        h('span', { text: size }),
        h('span', { text: `${g.download_count}↓` }),
        h('span', { class: 'faint', text: fmtDate(g.created_at) }),
      ]),
      h('div', { class: 'card-uploader flex', style: 'gap:6px;align-items:center;margin-top:6px;' }, [
        g.uploader_pfp ? h('img', { class: 'uploader-pfp', src: pfpUrl(g.uploader_pfp), alt: '' }) : null,
        h('span', { class: 'faint small', text: `@${g.uploader_name || 'system'}` }),
      ]),
    ]),
  ]);
}
