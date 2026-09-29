(() => {
  'use strict';

  const state = {
    rows: [],
    headers: [],
    timingIndex: 0,
    lightingIndex: 1,
    spotIndices: [],
    current: 0,
    sourceName: '',
    live: false,
    ownSpot: '',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('fileInput'),
    sourceLabel: $('sourceLabel'),
    cueCount: $('cueCount'),
    cueList: $('cueList'),
    listView: $('listView'),
    liveView: $('liveView'),
    viewToggle: $('viewToggle'),
    backToListBtn: $('backToListBtn'),
    resetBtn: $('resetBtn'),
    fullscreenBtn: $('fullscreenBtn'),
    prevBtn: $('prevBtn'),
    nextBtn: $('nextBtn'),
    liveIndex: $('liveIndex'),
    liveTotal: $('liveTotal'),
    currentCue: $('currentCue'),
    nextCue: $('nextCue'),
    dropOverlay: $('dropOverlay'),
    statusBar: $('statusBar'),
    statusText: $('statusText'),
    statusClose: $('statusClose'),
    emptyTemplate: $('emptyTemplate'),
  };

  const TIMING_ALIASES = ['タイミング', 'きっかけ', 'キュー', 'cue', 'timing', '歌詞', '場面', '区間', '箇所'];
  const LIGHTING_ALIASES = ['調光', '照明', 'lighting', 'light', 'ライト', '全体照明', '地明かり'];
  const CONTINUE_RE = /^(?:↓|⬇|〃|同|同上|継続|続き|つづき|keep|same)$/i;
  const OFF_RE = /^(?:消|消灯|off|なし|無し|×|x|-|—)$/i;
  const OWN_SPOT_STORAGE_KEY = 'spotlightCueViewer.ownSpot';

  try {
    state.ownSpot = localStorage.getItem(OWN_SPOT_STORAGE_KEY) || '';
  } catch {}

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function normalizeForMatch(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[\s　_\-‐‑–—・･·.。:：/／\\|()（）\[\]【】]/g, '');
  }

  function findAlias(headers, aliases, fallback) {
    const normalizedAliases = aliases.map(normalizeForMatch);
    const exact = headers.findIndex((header) => normalizedAliases.includes(normalizeForMatch(header)));
    if (exact >= 0) return exact;
    const partial = headers.findIndex((header) => {
      const h = normalizeForMatch(header);
      return normalizedAliases.some((alias) => h.includes(alias) || alias.includes(h));
    });
    return partial >= 0 ? partial : fallback;
  }

  function parseCSV(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }

    row.push(field);
    if (row.some((cell) => cell.length > 0) || rows.length === 0) rows.push(row);
    return rows;
  }

  function detectDelimiter(text) {
    const candidates = [',', '\t', ';'];
    let best = { delimiter: ',', score: -1, rows: [] };
    for (const delimiter of candidates) {
      const rows = parseCSV(text, delimiter);
      const meaningful = rows.slice(0, 8).filter((r) => r.some((c) => normalizeText(c)));
      const widths = meaningful.map((r) => r.length);
      const max = Math.max(0, ...widths);
      const stable = widths.filter((w) => w === max).length;
      const score = max > 1 ? max * 10 + stable : 0;
      if (score > best.score) best = { delimiter, score, rows };
    }
    return best;
  }

  function cleanupRows(rows) {
    return rows
      .map((row) => row.map(normalizeText))
      .filter((row) => row.some(Boolean));
  }

  function detectSchema(rows) {
    const headers = rows[0].map((h, i) => h || `列${i + 1}`);
    const timingIndex = findAlias(headers, TIMING_ALIASES, 0);
    let lightingIndex = findAlias(headers, LIGHTING_ALIASES, headers.length > 1 ? 1 : -1);
    if (lightingIndex === timingIndex) lightingIndex = headers.findIndex((_, i) => i !== timingIndex);

    const spotIndices = headers
      .map((_, index) => index)
      .filter((index) => index !== timingIndex && index !== lightingIndex);

    return { headers, timingIndex, lightingIndex, spotIndices };
  }

  function buildCueRows(rawRows, schema) {
    const width = schema.headers.length;
    const previousResolved = new Array(width).fill('');
    const warnings = [];

    const rows = rawRows.slice(1).map((raw, sourceRowIndex) => {
      if (raw.length !== width) {
        warnings.push(`${sourceRowIndex + 2}行目: ${raw.length}列（見出しは${width}列）`);
      }
      const cells = Array.from({ length: width }, (_, i) => normalizeText(raw[i] ?? ''));
      const values = cells.map((cell, col) => {
        const continued = CONTINUE_RE.test(normalizeForMatch(cell));
        const resolved = continued ? previousResolved[col] : cell;
        if (!continued && cell) previousResolved[col] = cell;
        return { raw: cell, resolved: resolved || '', continued };
      });
      return { sourceRow: sourceRowIndex + 2, values };
    }).filter((row) => row.values.some((v) => v.raw));

    return { rows, warnings };
  }

  function loadText(text, sourceName) {
    const cleanText = String(text).replace(/^\uFEFF/, '');
    const detected = detectDelimiter(cleanText);
    const cleaned = cleanupRows(detected.rows);
    if (cleaned.length < 2) throw new Error('有効なデータ行が見つかりませんでした。');

    const schema = detectSchema(cleaned);
    const built = buildCueRows(cleaned, schema);

    state.headers = schema.headers;
    state.timingIndex = schema.timingIndex;
    state.lightingIndex = schema.lightingIndex;
    state.spotIndices = schema.spotIndices;
    state.rows = built.rows;
    state.current = 0;
    state.sourceName = sourceName;

    if (!state.rows.length) throw new Error('キューが1件も見つかりませんでした。');

    els.sourceLabel.textContent = `${sourceName} · ${state.rows.length} cues`;
    els.cueCount.textContent = `${state.rows.length} cues`;
    hideStatus();

    const info = [];
    if (detected.delimiter !== ',') info.push(`区切り文字「${detected.delimiter === '\t' ? 'TAB' : detected.delimiter}」を自動判定`);
    if (built.warnings.length) info.push(`列数が異なる行: ${built.warnings.length}件`);
    if (info.length) showStatus(info.join(' / '));

    render();
  }

  async function decodeFile(file) {
    const buffer = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      try {
        return new TextDecoder('shift_jis', { fatal: true }).decode(buffer);
      } catch {
        return new TextDecoder('utf-8').decode(buffer);
      }
    }
  }

  function semanticClass(text) {
    const t = normalizeForMatch(text);
    if (!t) return '';
    if (/(暗転|blackout)/i.test(t)) return 'semantic-blackout';
    if (/(赤|red)/i.test(t)) return 'semantic-red';
    if (/(青|blue|水)/i.test(t)) return 'semantic-blue';
    if (/(黄|yellow)/i.test(t)) return 'semantic-yellow';
    if (/(緑|green)/i.test(t)) return 'semantic-green';
    if (/(橙|オレ|orange)/i.test(t)) return 'semantic-orange';
    if (/(白|生|white)/i.test(t)) return 'semantic-white';
    return '';
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function valueHTML(cell) {
    if (!cell || (!cell.raw && !cell.resolved)) return '<span class="empty-value">—</span>';
    const visible = cell.continued ? cell.resolved : cell.raw;
    const off = OFF_RE.test(normalizeForMatch(visible));
    const cls = [semanticClass(visible), off ? 'off' : ''].filter(Boolean).join(' ');
    const continuation = cell.continued ? '<span class="continue-mark">継続</span>' : '';
    return `${continuation}<span class="${cls}">${escapeHTML(visible || '—')}</span>`;
  }

  function cueCell(row, index) {
    return index >= 0 ? row.values[index] : { raw: '', resolved: '', continued: false };
  }

  function renderList() {
    if (!state.rows.length) {
      els.cueList.replaceChildren(els.emptyTemplate.content.cloneNode(true));
      return;
    }

    const fragment = document.createDocumentFragment();
    state.rows.forEach((row, index) => {
      const card = document.createElement('article');
      card.className = `cue-row${index === state.current ? ' is-current' : ''}`;
      card.tabIndex = 0;
      card.dataset.index = index;
      card.setAttribute('aria-label', `${index + 1}番目のキュー`);
      card.style.setProperty('--spot-count', Math.max(1, state.spotIndices.length));

      const spotHTML = state.spotIndices.map((col) => `
        <div class="spot-cell">
          <span class="label">${escapeHTML(state.headers[col])}</span>
          <div class="value">${valueHTML(cueCell(row, col))}</div>
        </div>`).join('');

      card.innerHTML = `
        <div class="cue-main">
          <span class="cue-number">${String(index + 1).padStart(2, '0')}</span>
          <div class="cue-time">${valueHTML(cueCell(row, state.timingIndex))}</div>
        </div>
        <div class="cue-lighting">
          <span class="label">${escapeHTML(state.headers[state.lightingIndex] || '調光')}</span>
          <div class="value">${valueHTML(cueCell(row, state.lightingIndex))}</div>
        </div>
        <div class="cue-spots">
          <div class="spot-grid">${spotHTML || '<span class="empty-value">スポット列なし</span>'}</div>
        </div>`;

      card.addEventListener('click', () => setCurrent(index));
      card.addEventListener('dblclick', () => { setCurrent(index); setLive(true); });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setCurrent(index);
          setLive(true);
        }
      });
      fragment.appendChild(card);
    });
    els.cueList.replaceChildren(fragment);
  }

  function compactSpots(row) {
    return state.spotIndices.map((col) => `
      <div class="spot-cell">
        <span class="label">${escapeHTML(state.headers[col])}</span>
        <div class="value">${valueHTML(cueCell(row, col))}</div>
      </div>`).join('');
  }

  function renderLive() {
    if (!state.rows.length) return;
    const row = state.rows[state.current];
    const next = state.rows[state.current + 1];
    els.liveIndex.textContent = String(state.current + 1);
    els.liveTotal.textContent = String(state.rows.length);
    els.currentCue.style.setProperty('--spot-count', Math.max(1, state.spotIndices.length));

    const spotsHTML = state.spotIndices.map((col) => {
      const label = state.headers[col];
      const selected = label === state.ownSpot;
      return `
        <button class="live-spot${selected ? ' is-own-spot' : ''}" type="button" data-spot="${escapeHTML(label)}" aria-pressed="${selected}" aria-label="${escapeHTML(label)}${selected ? '、自分のスポット' : 'を自分のスポットに選択'}">
          ${selected ? '<span class="own-spot-badge">自分のスポット</span>' : ''}
          <span class="label">${escapeHTML(label)}</span>
          <div class="value">${valueHTML(cueCell(row, col))}</div>
        </button>`;
    }).join('');

    els.currentCue.innerHTML = `
      <div>
        <span class="eyebrow">NOW · CUE ${String(state.current + 1).padStart(2, '0')}</span>
        <h2 class="live-timing">${valueHTML(cueCell(row, state.timingIndex))}</h2>
      </div>
      <div class="live-lighting">
        <span class="label">${escapeHTML(state.headers[state.lightingIndex] || '調光')}</span>
        <div class="value">${valueHTML(cueCell(row, state.lightingIndex))}</div>
      </div>
      <div>
        <span class="label own-spot-hint">スポットをタップして自分の担当を選択</span>
        <div class="live-spots">${spotsHTML || '<span class="empty-value">スポット列なし</span>'}</div>
      </div>`;

    if (next) {
      els.nextCue.innerHTML = `
        <div><span class="label">タイミング</span><div class="value">${valueHTML(cueCell(next, state.timingIndex))}</div></div>
        <div><span class="label">${escapeHTML(state.headers[state.lightingIndex] || '調光')}</span><div class="value">${valueHTML(cueCell(next, state.lightingIndex))}</div></div>
        <div><div class="spot-grid" style="--spot-count:${Math.max(1, state.spotIndices.length)}">${compactSpots(next)}</div></div>`;
    } else {
      els.nextCue.innerHTML = '<div style="grid-column:1/-1"><span class="label">END</span><div class="value empty-value">これが最後のキューです</div></div>';
    }

    els.prevBtn.disabled = state.current === 0;
    els.nextBtn.disabled = state.current === state.rows.length - 1;
    els.prevBtn.style.opacity = els.prevBtn.disabled ? '.45' : '1';
    els.nextBtn.style.opacity = els.nextBtn.disabled ? '.45' : '1';
  }

  function render() {
    renderList();
    renderLive();
  }

  function setCurrent(index, scroll = false) {
    if (!state.rows.length) return;
    state.current = Math.max(0, Math.min(state.rows.length - 1, index));
    render();
    if (scroll && !state.live) {
      els.cueList.querySelector(`[data-index="${state.current}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function step(delta) {
    setCurrent(state.current + delta, true);
  }

  function setLive(enabled) {
    state.live = Boolean(enabled);
    els.listView.hidden = state.live;
    els.liveView.hidden = !state.live;
    els.viewToggle.textContent = state.live ? '一覧表示' : 'ライブ表示';
    els.viewToggle.setAttribute('aria-pressed', String(state.live));
    renderLive();
  }

  function showStatus(message) {
    els.statusText.textContent = message;
    els.statusBar.hidden = false;
  }

  function hideStatus() {
    els.statusBar.hidden = true;
    els.statusText.textContent = '';
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      const text = await decodeFile(file);
      loadText(text, file.name);
    } catch (error) {
      showStatus(`読み込み失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  els.fileInput.addEventListener('change', (event) => loadFile(event.target.files?.[0]));
  els.viewToggle.addEventListener('click', () => setLive(!state.live));
  els.backToListBtn.addEventListener('click', () => setLive(false));
  els.resetBtn.addEventListener('click', () => setCurrent(0, true));
  els.prevBtn.addEventListener('click', () => step(-1));
  els.nextBtn.addEventListener('click', () => step(1));
  els.statusClose.addEventListener('click', hideStatus);
  els.currentCue.addEventListener('click', (event) => {
    const spot = event.target.closest('[data-spot]');
    if (!spot) return;
    const label = spot.dataset.spot;
    state.ownSpot = state.ownSpot === label ? '' : label;
    try {
      if (state.ownSpot) localStorage.setItem(OWN_SPOT_STORAGE_KEY, state.ownSpot);
      else localStorage.removeItem(OWN_SPOT_STORAGE_KEY);
    } catch {}
    renderLive();
  });
  els.fullscreenBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  });

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'J' || (event.key === ' ' && !event.shiftKey)) {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowUp' || event.key === 'k' || event.key === 'K' || (event.key === ' ' && event.shiftKey)) {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCurrent(0, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCurrent(state.rows.length - 1, true);
    } else if (event.key === 'l' || event.key === 'L') {
      setLive(!state.live);
    }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth++;
    els.dropOverlay.classList.add('is-active');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropOverlay.classList.remove('is-active');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.classList.remove('is-active');
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  async function loadDefaultData() {
    try {
      const response = await fetch('./data.csv', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const buffer = await response.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { text = new TextDecoder('shift_jis').decode(buffer); }
      loadText(text, 'data.csv');
    } catch {
      els.sourceLabel.textContent = 'CSVを選択してください';
      renderList();
    }
  }

  loadDefaultData();
})();
