/* =============================================
   Danbooru Tag Explorer — app.js
   Uses local data only (no external API calls)
   ============================================= */

'use strict';

// ── State ──────────────────────────────────────
const categoryTranslations = {
  "Visual characteristics": "視覚・外観的な特徴",
  "Image composition and style": "構図・スタイル",
  "Artistic license": "アレンジ表現",
  "Image composition": "構図",
  "Backgrounds": "背景",
  "Censorship": "修正・モザイク",
  "Colors": "色",
  "Focus tags": "フォーカスタグ",
  "Prints": "柄・プリント",
  "Text": "テキスト",
  "Symbols": "シンボル",
  "Year tags": "年代",
  "Body": "身体",
  "Body parts": "身体の部位",
  "Hair": "髪",
  "Face tags": "顔",
  "Breasts tags": "胸",
  "Ears tags": "耳",
  "Shoulders": "肩",
  "Skin color": "肌の色",
  "Tail": "尻尾",
  "Wings": "翼",
  "Ass": "お尻",
  "Hands": "手",
  "Legs": "脚",
  "Eyes": "目",
  "Injury": "怪我・負傷",
  "Attire and body accessories": "服装・アクセサリー",
  "Attire": "服装",
  "Dress": "ドレス",
  "Uniforms": "制服・ユニフォーム",
  "blouse": "ブラウス",
  "shirt": "シャツ",
  "sweater": "セーター",
  "tank_top": "タンクトップ",
  "skirt": "スカート",
  "cardigan": "カーディガン",
  "coat": "コート",
  "Headwear": "帽子・頭部の装飾",
  "Legwear": "レッグウェア（靴下等）",
  "Neck and neckwear": "首飾り",
  "Sexual attire": "セクシーな服装",
  "Sleeves": "袖",
  "Swimsuit": "水着",
  "Eyewear": "眼鏡",
  "japanese_clothes": "和服",
  "Nudity": "裸体表現",
  "Sex": "エッチな描写",
  "Sex acts": "エッチな行為",
  "Objects": "オブジェクト",
  "Computer": "コンピュータ",
  "Weapons": "武器",
  "Audio tags": "オーディオ",
  "Cards": "カード",
  "Creatures": "生物",
  "Animals": "動物",
  "Legendary creatures": "伝説の生物",
  "Plants": "植物",
  "Flowers": "花",
  "Tree": "木",
  "Games": "ゲーム",
  "Video game": "ビデオゲーム",
  "Sports": "スポーツ",
  "Real world": "現実世界",
  "Companies and brand names": "企業・ブランド名",
  "Holidays and celebrations": "休日・お祝い",
  "Jobs": "職業",
  "Locations": "場所",
  "People": "人物",
  "More": "その他",
  "Family relationships": "家族関係",
  "Food tags": "食べ物",
  "Technology (includes Sci-Fi)": "テクノロジー(SF含む)",
  "Water": "水",
  "Fire": "炎",
  "Copyrights, artists, projects and media": "版権・アーティスト・メディア",
  "Genres of video games": "ゲームジャンル",
  "Artists": "アーティスト",
  "Characters": "キャラクター",
  "Metatags": "メタタグ",
  "Drawing Software": "お絵かきソフト"
};

function translateCategory(name) {
  return categoryTranslations[name] || name;
}

const HISTORY_MAX = 30;

// A1111 モードフラグ。
// A1111 環境では build_index_html() が window.__DTE_MODE__ = 'a1111' を注入するため、
// API 呼び出しを待たずモジュールロード時に 'a1111' で初期化される。
// boot() 内で loadServerSettings() の結果により更新されるが、API 失敗時は注入値を保持。
let _mode = (typeof window.__DTE_MODE__ === 'string') ? window.__DTE_MODE__ : null;

const state = {
  tree: null,           // parsed tag_tree.json
  tagMeta: new Map(),   // name → {count, category}
  translations: new Map(), // name → japanese
  tagNodes: new Map(),  // name → {url, breadcrumb}
  flatTags: [],         // [{name, url, breadcrumb[]}]
  currentPath: [],
  searchDebounce: null,
  filterDebounce: null,
  renderOffset: 0,
  BATCH: 80,
  minPostCount: 0,
  _currentTags: [],
  favTags: new Set(JSON.parse(localStorage.getItem('favTags') || '[]')),   // overwritten by server on boot
  pinnedCats: JSON.parse(localStorage.getItem('pinnedCats') || '[]'),      // overwritten by server on boot
  // History
  history: {
    searches:    JSON.parse(localStorage.getItem('history_searches')    || '[]'),
    categories:  JSON.parse(localStorage.getItem('history_categories')  || '[]'),
    stocks:      JSON.parse(localStorage.getItem('history_stocks')      || '[]'),
  },
  // History type filter (which types are visible)
  historyFilter: JSON.parse(localStorage.getItem('historyFilter') || '{"search":true,"category":true,"stock":true}'),
  // Sidebar section collapse state
  sectionCollapsed: JSON.parse(localStorage.getItem('sectionCollapsed') || '{}'),
  llmConfig: {
    preset: 'ollama', host: 'localhost', port: 11434,
    path: '/v1', apiKey: '', model: '', timeout: 30,
  },
};

// ── Persistence helpers ─────────────────────────────────────────────────────
// localStorage is always updated as a local cache.
// If Flask server is running, also sync to server (fire-and-forget).
// Falls back silently when using plain python -m http.server.

function saveFavs() {
  const arr = Array.from(state.favTags);
  localStorage.setItem('favTags', JSON.stringify(arr));
  fetch('api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(arr),
  }).catch(() => {}); // ignore if static server
}

function savePins() {
  localStorage.setItem('pinnedCats', JSON.stringify(state.pinnedCats));
  fetch('api/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.pinnedCats),
  }).catch(() => {}); // ignore if static server
}

// Called once at boot start: loads server-side settings (CSV paths, favs, pins).
// Returns { tagCsv, jaCsv, _mode } using server values when available, else defaults.
// _mode === 'a1111' の場合、CSVは専用エンドポイント (api/csv/*) 経由で取得する。
// If the API is unavailable (non-Flask server), silently keeps localStorage values.
async function loadServerSettings() {
  const defaults = { tagCsv: 'data/danbooru.csv', jaCsv: 'data/ja.csv', _mode: null };
  try {
    const res = await fetch('api/settings', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return defaults;
    const data = await res.json();
    if (Array.isArray(data.favTags)) {
      state.favTags = new Set(data.favTags);
      localStorage.setItem('favTags', JSON.stringify(data.favTags));
    }
    if (Array.isArray(data.pinnedCats)) {
      state.pinnedCats = data.pinnedCats;
      localStorage.setItem('pinnedCats', JSON.stringify(state.pinnedCats));
    }
    if (data.llm && typeof data.llm === 'object') {
      Object.assign(state.llmConfig, data.llm);
    }
    return {
      tagCsv: (typeof data.tagCsv === 'string' && data.tagCsv) ? data.tagCsv : defaults.tagCsv,
      jaCsv:  (typeof data.jaCsv  === 'string' && data.jaCsv)  ? data.jaCsv  : defaults.jaCsv,
      _mode:  data._mode ?? null,
    };
  } catch (_e) {
    return defaults;
  }
}

function saveSectionCollapsed() {
  localStorage.setItem('sectionCollapsed', JSON.stringify(state.sectionCollapsed));
}

// Creates a collapsible section header for sidebar sections (fav / tree / history).
// The immediately following sibling element is used as the collapsible body.
function makeSectionHeader(label, sectionKey, badgeText) {
  const header = document.createElement('div');
  header.className = 'sidebar-section-header sidebar-section-header--toggle';

  const chevron = document.createElement('span');
  chevron.className = 'section-chevron';
  chevron.classList.toggle('open', !state.sectionCollapsed[sectionKey]);

  const titleEl = document.createElement('span');
  titleEl.className = 'section-header-title';
  titleEl.textContent = label;

  header.appendChild(chevron);
  header.appendChild(titleEl);

  if (badgeText != null) {
    const badge = document.createElement('span');
    badge.className = 'tree-badge';
    badge.textContent = badgeText;
    header.appendChild(badge);
  }

  header.addEventListener('click', () => {
    const newVal = !state.sectionCollapsed[sectionKey];
    state.sectionCollapsed[sectionKey] = newVal;
    saveSectionCollapsed();
    chevron.classList.toggle('open', !newVal);
    const body = header.nextElementSibling;
    if (body) body.style.display = newVal ? 'none' : '';
  });

  return header;
}

// ── History ─────────────────────────────────────
function saveHistory() {
  localStorage.setItem('history_searches',   JSON.stringify(state.history.searches));
  localStorage.setItem('history_categories', JSON.stringify(state.history.categories));
  localStorage.setItem('history_stocks',     JSON.stringify(state.history.stocks));
}

function addHistorySearch(query) {
  if (!query) return;
  const arr = state.history.searches;
  const idx = arr.findIndex(e => e.q === query);
  if (idx !== -1) arr.splice(idx, 1);
  arr.unshift({ q: query, t: Date.now() });
  if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
  saveHistory();
  renderHistoryNav();
}

function addHistoryCategory(path) {
  if (!path || path.length === 0) return;
  if (path[0].startsWith('__')) return; // skip special paths
  const key = JSON.stringify(path);
  const arr = state.history.categories;
  const idx = arr.findIndex(e => JSON.stringify(e.path) === key);
  if (idx !== -1) arr.splice(idx, 1);
  arr.unshift({ path: [...path], t: Date.now() });
  if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
  saveHistory();
  renderHistoryNav();
}

function addHistoryStock(name) {
  if (!name) return;
  const arr = state.history.stocks;
  const idx = arr.findIndex(e => e.name === name);
  if (idx !== -1) arr.splice(idx, 1);
  arr.unshift({ name, t: Date.now() });
  if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
  saveHistory();
  renderHistoryNav();
}

function clearHistory() {
  state.history.searches = [];
  state.history.categories = [];
  state.history.stocks = [];
  saveHistory();
  renderHistoryNav();
  showToast('🗑 履歴をクリアしました');
}

// ── DOM refs ────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  globalSearch:    $('global-search'),
  searchClear:     $('search-clear'),
  searchLlmBtn:    $('search-llm-btn'),
  searchOverlay:   $('search-results-overlay'),
  searchList:      $('search-results-list'),
  searchCount:     $('search-results-count'),
  searchAiBadge:      $('search-ai-badge'),
  searchAiCandidates: $('search-ai-candidates'),
  searchEnterHint:    $('search-enter-hint'),
  treeNav:         $('tree-nav'),
  expandAll:       $('expand-all'),
  collapseAll:     $('collapse-all'),
  breadcrumb:      $('breadcrumb'),
  breadcrumbHome:  $('breadcrumb-home'),
  welcomeState:    $('welcome-state'),
  tagListSection:  $('tag-list-section'),
  categoryTitle:   $('current-category-title'),
  tagCount:        $('current-tag-count'),
  viewModeSelect:  $('view-mode-select'),
  sortSelect:      $('sort-select'),
  filterMenuBtn:      $('filter-menu-btn'),
  filterMenuDropdown: $('filter-menu-dropdown'),
  filterActiveBadge:  $('filter-active-badge'),
  filterClearBtn:     $('filter-clear-btn'),
  filterCheckboxes:   () => document.querySelectorAll('.filter-checkbox'),
  subcatChips:     $('subcategory-chips'),
  tagsGrid:        $('tags-grid'),
  toast:           $('toast'),
  loadingOverlay:  $('loading-overlay'),
  tagCountBadge:   $('tag-count-badge'),
  minPostFilter:   $('min-post-filter'),
  resizer:         $('resizer'),
  sidebar:         $('sidebar'),
  sidebarOverlay:  $('sidebar-overlay'),
  favNav:          $('fav-nav'),
  favDivider:      $('fav-divider'),
  historyNav:      $('history-nav'),
  historyDivider:  $('history-divider'),
  pinCategoryBtn:  $('pin-category-btn'),
  statCategories:  $('stat-categories'),
  statTags:        $('stat-tags'),
  scratchpadInput: $('scratchpad-input'),
  scratchpadCopy:  $('scratchpad-copy'),
  scratchpadClear: $('scratchpad-clear'),
  scratchpadToggle:$('scratchpad-toggle'),
  replaceUnderscore:$('replace-underscore'),
  appendComma:     $('append-comma'),
  themeToggle:     $('theme-toggle'),
  mobileMenuBtn:   $('mobile-menu-btn'),
  sidebarCloseBtn: $('sidebar-close-btn'),
  cardSizeWrap:       $('card-size-wrap'),
  cardSizeSlider:     $('card-size-slider'),
  cardContextMenu:    $('card-context-menu'),
  ctxDanbooruPosts:   $('ctx-danbooru-posts'),
  ctxDetail:          $('ctx-detail'),
  tagDetailOverlay:   $('tag-detail-overlay'),
  detailTagName:      $('detail-tag-name'),
  detailTagJa:        $('detail-tag-ja'),
  detailBreadcrumb:   $('detail-breadcrumb'),
  detailPostCount:    $('detail-post-count'),
  detailWikiBody:     $('detail-wiki-body'),
  detailWikiBtn:      $('detail-wiki-btn'),
  detailFavBtn:       $('detail-fav-btn'),
  detailCopyBtn:      $('detail-copy-btn'),
  detailCloseBtn:     $('detail-close-btn'),
  // A1111 integration
  a1111Actions:        $('a1111-actions'),
  a1111ReadBtn:        $('a1111-read-btn'),
  a1111SendBtn:        $('a1111-send-btn'),
  a1111PromptTarget:   $('a1111-prompt-target'),
  scratchpadFormatBtn: $('scratchpad-format-btn'),
  scratchpadTagList:   $('scratchpad-tag-list'),
  tabPanelPrompt: $('tab-panel-prompt'),
  tabPanelLlm:    $('tab-panel-llm'),
  llmJpInput:     $('llm-jp-input'),
  llmTagOutput:   $('llm-tag-output'),
  llmTagList:     $('llm-tag-list'),
  llmConvertBtn:  $('llm-convert-btn'),
  llmCopyBtn:     $('llm-copy-btn'),
  llmClearBtn:    $('llm-clear-btn'),
  settingsBtn:          $('settings-btn'),
  settingsOverlay:      $('settings-overlay'),
  settingsCloseBtn:     $('settings-close-btn'),
  settingsSaveBtn:      $('settings-save-btn'),
  settingsCancelBtn:    $('settings-cancel-btn'),
  llmPresetSelect:      $('llm-preset-select'),
  llmHost:              $('llm-host'),
  llmPort:              $('llm-port'),
  llmPath:              $('llm-path'),
  llmApiKey:            $('llm-apikey'),
  llmModelSelect:       $('llm-model-select'),
  llmFetchModelsBtn:    $('llm-fetch-models-btn'),
  llmModelNote:         $('llm-model-note'),
  llmUnloadRow:         $('llm-unload-row'),
  llmUnloadBtn:         $('llm-unload-btn'),
  llmUnloadNote:        $('llm-unload-note'),
  llmTestBtn:           $('llm-test-btn'),
  llmTestNote:          $('llm-test-note'),
  csvTagPath:           $('csv-tag-path'),
  csvJaPath:            $('csv-ja-path'),
  settingsCsvFields:    $('settings-csv-fields'),
  settingsCsvA1111Note: $('settings-csv-a1111-note'),
  dteDialog:           $('dte-dialog'),
  dteDialogMessage:    $('dte-dialog-message'),
  dteDialogButtons:    $('dte-dialog-buttons'),
};

// ── Boot ────────────────────────────────────────
async function boot() {
  try {
    // Step 1: fetch server settings first to resolve CSV paths + favs/pins
    updateLoadingText('設定を読み込み中…');
    const { tagCsv, jaCsv, _mode: detectedMode } = await loadServerSettings();
    _mode = detectedMode ?? _mode;  // API 成功時は上書き、失敗時は注入値(__DTE_MODE__)を保持

    // A1111モードでは専用エンドポイント経由でCSVを取得する。
    // これにより shared.opts で設定された絶対パスや BASE_DIR 外のファイルも配信できる。
    // スタンドアロンモード (_mode === null) では従来通り相対パスで直接 fetch する。
    const tagCsvUrl = _mode === 'a1111' ? 'api/csv/danbooru' : './' + tagCsv;
    const jaCsvUrl  = _mode === 'a1111' ? 'api/csv/ja'       : './' + jaCsv;
    const csvName   = _mode === 'a1111' ? 'danbooru.csv'     : tagCsv.split('/').pop();

    // Step 2: fetch data files using configured paths
    updateLoadingText(`タグメタデータを読み込み中… (${csvName})`);
    const [treeRes, csvRes, jaRes] = await Promise.all([
      fetch('./data/tag_tree.json'),
      fetch(tagCsvUrl),
      fetch(jaCsvUrl).catch(() => null)
    ]);
    if (!treeRes.ok) throw new Error(`tag_tree.json: HTTP ${treeRes.status}`);
    if (!csvRes.ok)  throw new Error(`${csvName}: HTTP ${csvRes.status}`);

    updateLoadingText('JSONを解析中…');
    state.tree = await treeRes.json();

    updateLoadingText('CSVを解析中…');
    const csvText = await csvRes.text();
    parseTagsCSV(csvText);

    if (jaRes && jaRes.ok) {
      updateLoadingText('翻訳データを解析中…');
      const jaText = await jaRes.text();
      parseTranslations(jaText);
    }

    updateLoadingText('ツリーを正規化中…');
    cleanTreeKeys(state.tree);
    mergeCaseInsensitiveSiblings(state.tree);

    updateLoadingText('インデックスを構築中…');
    await nextFrame();
    buildFlatIndex(state.tree, []);

    updateLoadingText('ツリーを描画中…');
    await nextFrame();
    renderFavTree();
    renderHistoryNav();
    renderTree();
    updateStats();
    hideLoading();

    if (_mode === 'a1111') initA1111Mode();
    tryAutoDetectLlm(); // non-blocking: サイレントでモデル自動検出

    state.observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        appendTagBatch();
      }
    }, { root: els.tagsGrid, rootMargin: '400px' });
  } catch (e) {
    console.error(e);
    els.loadingOverlay.innerHTML =
      `<div style="color:#f87171;text-align:center;padding:32px">
        <p style="font-size:18px">⚠ データの読み込みに失敗しました</p>
        <p style="font-size:12px;margin-top:8px;color:#7878a0">${e.message}</p>
        <p style="font-size:11px;margin-top:4px;color:#505070">data/ フォルダに tag_tree.json と danbooru.csv があるか確認してください</p>
       </div>`;
  }
}

function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}

function updateLoadingText(msg) {
  const el = els.loadingOverlay.querySelector('.loading-text');
  if (el) el.textContent = msg;
}

function hideLoading() {
  els.loadingOverlay.classList.add('hidden');
  setTimeout(() => els.loadingOverlay.remove(), 400);
}

// ── CSV Parser ──────────────────────────────────
// Format: name,category,post_count[,aliases]
function parseTagsCSV(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const comma1 = line.indexOf(',');
    const comma2 = line.indexOf(',', comma1 + 1);
    const comma3 = line.indexOf(',', comma2 + 1);
    if (comma1 === -1 || comma2 === -1) continue;
    const name     = line.slice(0, comma1).trim();
    const category = parseInt(line.slice(comma1 + 1, comma2).trim(), 10);
    const countStr = comma3 === -1
      ? line.slice(comma2 + 1).trim()
      : line.slice(comma2 + 1, comma3).trim();
    const count = parseInt(countStr, 10);
    if (name && !isNaN(count)) {
      state.tagMeta.set(name, { count, category });
    }
  }
}

function parseTranslations(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length >= 2) {
      state.translations.set(parts[0].trim(), parts[1].trim());
    }
  }
}

// ── Tree Normalization ──────────────────────────
function resolveTagName(rawName) {
  if (state.tagMeta.has(rawName)) return rawName;

  const underName = rawName.replace(/ /g, '_');
  if (state.tagMeta.has(underName)) return underName;

  const match = rawName.match(/^(.*?)\s+\([^)]+\)$/);
  if (match) {
    const stripped = match[1].replace(/ /g, '_');
    if (state.tagMeta.has(stripped)) return stripped;
  }
  return rawName;
}

// ── Case-insensitive category deduplication ─────
// Merge sibling keys that differ only in case (e.g. "Wings" vs "wings").
// Canonical key: prefer the one whose first letter is uppercase; otherwise first seen.
function mergedNode(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  // Both strings → keep a (first seen)
  if (typeof a === 'string' && typeof b === 'string') return a;
  // String + object → promote string to .self on the object
  if (typeof a === 'string' && typeof b === 'object') {
    const r = Object.assign({}, b);
    if (!r.self) r.self = a;
    return r;
  }
  if (typeof a === 'object' && typeof b === 'string') {
    if (!a.self) a.self = b;
    return a;
  }
  // Both objects → deep merge b into a copy of a
  const result = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    result[k] = k in result ? mergedNode(result[k], v) : v;
  }
  return result;
}

function mergeCaseInsensitiveSiblings(node) {
  if (!node || typeof node !== 'object') return;
  // Pass 1: detect duplicates and pick canonical key
  const canonical = new Map(); // lowercase → chosen key
  for (const key of Object.keys(node)) {
    if (key === 'self') continue;
    const lk = key.toLowerCase();
    if (!canonical.has(lk)) {
      canonical.set(lk, key);
    } else {
      // Prefer the key whose first character is uppercase
      const cur = canonical.get(lk);
      if (key[0] === key[0].toUpperCase() && key[0] !== key[0].toLowerCase()) {
        canonical.set(lk, key); // switch canonical to this one
      }
    }
  }
  // Pass 2: merge non-canonical keys into canonical
  for (const key of Object.keys(node)) {
    if (key === 'self') continue;
    const lk = key.toLowerCase();
    const canon = canonical.get(lk);
    if (canon !== key) {
      // Merge this key into the canonical one
      node[canon] = mergedNode(node[canon], node[key]);
      delete node[key];
    }
  }
  // Recurse into surviving children
  for (const [key, val] of Object.entries(node)) {
    if (key !== 'self' && typeof val === 'object' && val !== null) {
      mergeCaseInsensitiveSiblings(val);
    }
  }
}

function cleanTreeKeys(node) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (key.startsWith('__')) continue;
    const val = node[key];
    if (typeof val === 'object') {
      cleanTreeKeys(val);
    } else if (typeof val === 'string') {
      const newKey = resolveTagName(key);
      if (newKey !== key) {
        node[newKey] = val;
        delete node[key];
      }
    }
  }
}

// ── Flat Index ──────────────────────────────────
function buildFlatIndex(node, breadcrumb) {
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (key === 'self') continue;
    if (val === null) continue;
    if (typeof val === 'string') {
      state.flatTags.push({ name: key, url: val, breadcrumb: [...breadcrumb] });
      state.tagNodes.set(key, { url: val, breadcrumb: [...breadcrumb] });
    } else if (typeof val === 'object') {
      if (val.self && typeof val.self === 'string') {
        state.flatTags.push({ name: key, url: val.self, breadcrumb: [...breadcrumb] });
        state.tagNodes.set(key, { url: val.self, breadcrumb: [...breadcrumb] });
      }
      buildFlatIndex(val, [...breadcrumb, key]);
    }
  }
}

function updateStats() {
  const cats = Object.keys(state.tree || {}).length;
  els.statCategories.textContent = cats.toLocaleString();
  els.statTags.textContent       = state.flatTags.length.toLocaleString();
  els.tagCountBadge.textContent  = state.tagMeta.size.toLocaleString() + ' tags';
}

// ── Tree Rendering ──────────────────────────────
function renderFavTree() {
  els.favNav.innerHTML = '';
  const hasFavs = state.favTags.size > 0 || state.pinnedCats.length > 0;
  els.favNav.style.display = hasFavs ? 'block' : 'none';
  els.favDivider.style.display = hasFavs ? 'block' : 'none';
  if (!hasFavs) return;

  const totalCount = state.favTags.size + state.pinnedCats.length;
  els.favNav.appendChild(makeSectionHeader('♥ お気に入り・ピン止め', 'fav', totalCount));

  const body = document.createElement('div');
  body.className = 'section-body';
  if (state.sectionCollapsed.fav) body.style.display = 'none';
  els.favNav.appendChild(body);

  // All Fav Tags Node
  if (state.favTags.size > 0) {
    const allFavNode = document.createElement('div');
    allFavNode.className = 'tree-node';
    allFavNode.innerHTML = `<div class="tree-label"><span class="tree-label-text" style="color:var(--danger)">♡ お気に入りタグ</span><span class="tree-badge">${state.favTags.size}</span></div>`;
    allFavNode.addEventListener('click', () => navigateTo(['__fav_tags__']));
    body.appendChild(allFavNode);
  }

  // Pinned Categories
  state.pinnedCats.forEach(path => {
    const pinNode = document.createElement('div');
    pinNode.className = 'tree-node';
    let label;
    if (path[0] === '__search_query__') {
      label = `🔍 "${path[1]}"`;
    } else {
      label = '📌 ' + translateCategory(path[path.length - 1] || 'Root');
    }
    pinNode.innerHTML = `<div class="tree-label"><span class="tree-label-text">${escHtml(label)}</span></div>`;
    pinNode.addEventListener('click', () => navigateTo(path));
    body.appendChild(pinNode);
  });
}

// ── History Nav Rendering ────────────────────────
function renderHistoryNav() {
  const nav = els.historyNav;
  if (!nav) return;
  nav.innerHTML = '';

  const { searches, categories, stocks } = state.history;
  const totalCount = searches.length + categories.length + stocks.length;
  const hasAny = totalCount > 0;

  nav.style.display = hasAny ? 'block' : 'none';
  els.historyDivider.style.display = hasAny ? 'block' : 'none';
  if (!hasAny) return;

  const f = state.historyFilter;
  const visibleCount =
    (f.search   ? searches.length   : 0) +
    (f.category ? categories.length : 0) +
    (f.stock    ? stocks.length     : 0);

  const header = makeSectionHeader('📋 履歴', 'history', visibleCount);

  // フィルターボタン（🔍 📁 🏷️）
  const filterWrap = document.createElement('span');
  filterWrap.className = 'history-filter-wrap';
  const mkBtn = (icon, key, title) => {
    const btn = document.createElement('button');
    btn.className = 'history-filter-btn' + (f[key] ? ' active' : '');
    btn.textContent = icon;
    btn.title = title;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.historyFilter[key] = !state.historyFilter[key];
      localStorage.setItem('historyFilter', JSON.stringify(state.historyFilter));
      renderHistoryNav();
    });
    filterWrap.appendChild(btn);
  };
  mkBtn('🔍', 'search',   '検索履歴を表示/非表示');
  mkBtn('📁', 'category', 'カテゴリ履歴を表示/非表示');
  mkBtn('🏷️', 'stock',    'タグ履歴を表示/非表示');
  header.appendChild(filterWrap);
  nav.appendChild(header);

  const body = document.createElement('div');
  body.className = 'section-body';
  if (state.sectionCollapsed.history) body.style.display = 'none';
  nav.appendChild(body);

  // Helper: render a flat group of items under a type
  function renderHistoryGroup(icon, items) {
    items.forEach(({ label, sublabel, onNavigate, onDelete }) => {
      const itemNode = document.createElement('div');
      itemNode.className = 'tree-node history-item-node';

      const itemLabel = document.createElement('div');
      itemLabel.className = 'history-item-label';

      const iconEl = document.createElement('span');
      iconEl.className = 'history-type-icon';
      iconEl.textContent = icon;

      const textEl = document.createElement('span');
      textEl.className = 'history-item-text';
      textEl.textContent = label;
      textEl.title = sublabel ? `${label}\n${sublabel}` : label;

      itemLabel.appendChild(iconEl);
      itemLabel.appendChild(textEl);

      if (sublabel) {
        const sub = document.createElement('span');
        sub.className = 'history-item-sublabel';
        sub.textContent = sublabel;
        itemLabel.appendChild(sub);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'history-item-del';
      delBtn.textContent = '✕';
      delBtn.title = '削除';
      delBtn.addEventListener('click', e => { e.stopPropagation(); onDelete(); });
      itemLabel.appendChild(delBtn);

      itemLabel.addEventListener('click', e => {
        e.stopPropagation();
        closeSidebarOnMobile();
        onNavigate();
      });

      itemNode.appendChild(itemLabel);
      body.appendChild(itemNode);
    });
  }

  // 🔍 検索
  if (f.search) renderHistoryGroup('🔍', searches.map(e => ({
    label: `"${e.q}"`,
    sublabel: '',
    onNavigate: () => navigateTo(['__search_query__', e.q]),
    onDelete: () => {
      const idx = state.history.searches.findIndex(x => x.q === e.q && x.t === e.t);
      if (idx !== -1) state.history.searches.splice(idx, 1);
      saveHistory(); renderHistoryNav();
    },
  })));

  // 📁 カテゴリ
  if (f.category) renderHistoryGroup('📁', categories.map(e => ({
    label: translateCategory(e.path[e.path.length - 1]),
    sublabel: e.path.length > 1
      ? e.path.slice(0, -1).map(translateCategory).join(' › ')
      : '',
    onNavigate: () => navigateTo(e.path),
    onDelete: () => {
      const key = JSON.stringify(e.path);
      const idx = state.history.categories.findIndex(x => JSON.stringify(x.path) === key && x.t === e.t);
      if (idx !== -1) state.history.categories.splice(idx, 1);
      saveHistory(); renderHistoryNav();
    },
  })));

  // 🏷️ タグ（旧称: ストック）
  if (f.stock) renderHistoryGroup('🏷️', stocks.map(e => ({
    label: e.name,
    sublabel: '',
    onNavigate: () => navigateTo(['__search_result__', e.name]),
    onDelete: () => {
      const idx = state.history.stocks.findIndex(x => x.name === e.name && x.t === e.t);
      if (idx !== -1) state.history.stocks.splice(idx, 1);
      saveHistory(); renderHistoryNav();
    },
  })));

  // Clear all button
  const clearWrap = document.createElement('div');
  clearWrap.className = 'history-clear-wrap';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'history-clear-btn';
  clearBtn.textContent = '🗑 すべてクリア';
  clearBtn.addEventListener('click', e => { e.stopPropagation(); clearHistory(); });
  clearWrap.appendChild(clearBtn);
  body.appendChild(clearWrap);
}

function renderTree() {
  els.treeNav.innerHTML = '';

  els.treeNav.appendChild(makeSectionHeader('📁 カテゴリ', 'tree'));

  const body = document.createElement('div');
  body.className = 'section-body';
  if (state.sectionCollapsed.tree) body.style.display = 'none';
  els.treeNav.appendChild(body);

  for (const [key, val] of Object.entries(state.tree)) {
    body.appendChild(createNode(key, val, 0));
  }
}

function createNode(key, val, depth) {
  if (val === null) val = {};
  const isLeaf = typeof val === 'string';
  const children = isLeaf ? [] : Object.entries(val).filter(([k, v]) => k !== 'self' && v !== null && typeof v !== 'string');
  const hasChildren = children.length > 0;

  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.depth = depth;
  node.dataset.key = key;

  const label = document.createElement('div');
  label.className = 'tree-label';

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  chevron.textContent = hasChildren ? '▶' : '';

  const folderIcon = document.createElement('span');
  folderIcon.className = 'tree-folder-icon';

  const text = document.createElement('span');
  text.className = 'tree-label-text';
  text.textContent = translateCategory(key);
  text.title = key;

  const badge = document.createElement('span');
  badge.className = 'tree-badge';
  if (hasChildren) badge.textContent = countLeaves(val);

  label.appendChild(chevron);
  label.appendChild(folderIcon);
  label.appendChild(text);
  label.appendChild(badge);
  node.appendChild(label);

  if (hasChildren) {
    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children';
    for (const [ck, cv] of children) {
      childWrap.appendChild(createNode(ck, cv, depth + 1));
    }
    node.appendChild(childWrap);

    label.addEventListener('click', e => {
      e.stopPropagation();
      const open = label.classList.toggle('open');
      childWrap.classList.toggle('open', open);
      navigateTo(getPathForNode(node));
    });
  } else {
    label.addEventListener('click', e => {
      e.stopPropagation();
      navigateTo(getPathForNode(node));
    });
  }
  return node;
}

function countLeaves(node, _seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return 0;
  if (_seen.has(node)) return 0;
  _seen.add(node);
  let c = 0;
  for (const [k, v] of Object.entries(node)) {
    if (v === null) continue;
    if (k === 'self') { c++; continue; }
    if (typeof v === 'string') c++;
    else c += countLeaves(v, _seen);
  }
  return c;
}

function getPathForNode(nodeEl) {
  const path = [];
  let cur = nodeEl;
  while (cur && cur !== els.treeNav) {
    if (cur.classList.contains('tree-node') && cur.dataset.key) {
      path.unshift(cur.dataset.key);
    }
    cur = cur.parentElement;
  }
  return path;
}

// ── Mobile sidebar ──────────────────────────────
function openSidebar() {
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 640) closeSidebar();
}

// ── Navigation ──────────────────────────────────
function navigateTo(path) {
  state.currentPath = path;
  state.renderOffset = 0;

  // Close sidebar on mobile when navigating
  closeSidebarOnMobile();

  document.querySelectorAll('.tree-label.active').forEach(el => el.classList.remove('active'));

  if (path.length > 0 && path[0] === '__fav_tags__') {
    renderBreadcrumb(['⭐ お気に入りタグ']);
    els.welcomeState.classList.add('hidden');
    els.tagListSection.classList.remove('hidden');
    els.categoryTitle.textContent = 'お気に入りタグ';
    els.subcatChips.innerHTML = '';
    els.pinCategoryBtn.classList.add('hidden');

    const tags = Array.from(state.favTags).map(name => {
      const flat = state.flatTags.find(t => t.name === name);
      return { name, url: flat ? flat.url : '' };
    });
    renderTagGrid(tags, [], path);
    return;
  }

  if (path.length > 0 && path[0] === '__search_result__') {
    const targetTag = path[1];
    renderBreadcrumb(['🔍 タグ詳細 / 関連タグ', targetTag]);
    els.welcomeState.classList.add('hidden');
    els.tagListSection.classList.remove('hidden');
    els.categoryTitle.textContent = '関連タグ';
    els.subcatChips.innerHTML = '';
    els.pinCategoryBtn.classList.add('hidden');

    const relatedNames = getRelatedTags(targetTag);
    const tags = [];
    if (state.tagMeta.has(targetTag)) {
      tags.push({ name: targetTag, url: state.tagNodes.get(targetTag)?.url || '' });
    }

    for (const r of relatedNames) {
      if (r !== targetTag) {
        tags.push({ name: r, url: state.tagNodes.get(r)?.url || '' });
      }
    }

    renderTagGrid(tags, [], path);
    return;
  }

  if (path.length > 0 && path[0] === '__search_query__') {
    const query = path[1];
    renderBreadcrumb([`🔍 "${query}"`]);
    els.welcomeState.classList.add('hidden');
    els.tagListSection.classList.remove('hidden');
    els.categoryTitle.textContent = `"${query}" の検索結果`;
    els.subcatChips.innerHTML = '';

    // Pin button for search queries
    els.pinCategoryBtn.classList.remove('hidden');
    const isQPinned = state.pinnedCats.some(p => JSON.stringify(p) === JSON.stringify(path));
    els.pinCategoryBtn.style.opacity = isQPinned ? '1' : '0.5';
    els.pinCategoryBtn.onclick = () => {
      if (isQPinned) {
        state.pinnedCats = state.pinnedCats.filter(p => JSON.stringify(p) !== JSON.stringify(path));
        showToast('📌 ピン留めを解除しました');
      } else {
        state.pinnedCats.push(path);
        showToast('📌 ピン留めしました');
      }
      savePins();
      renderFavTree();
      navigateTo(path);
    };

    renderTagGrid(getSearchQueryTags(query), [], path);
    return;
  }

  // Regular category navigation — record in history
  if (path.length > 0) {
    addHistoryCategory(path);

    const activeNode = findTreeNode(path);
    if (activeNode) {
      const activeLabel = activeNode.querySelector?.(':scope > .tree-label');
      activeLabel?.classList.add('active');
      expandAncestors(activeNode);
      // アクティブノード自身も展開してサブカテゴリを表示（左クリックと同じ動作）
      const activeChildren = activeNode.querySelector(':scope > .tree-children');
      if (activeChildren) {
        activeLabel?.classList.add('open');
        activeChildren.classList.add('open');
      }
      // サイドバーのアクティブ項目をスクロールして見えるようにする
      activeLabel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  renderBreadcrumb(path);
  renderContent(path);

  // Pin button logic
  if (path.length > 0) {
    els.pinCategoryBtn.classList.remove('hidden');
    const isPinned = state.pinnedCats.some(p => JSON.stringify(p) === JSON.stringify(path));
    els.pinCategoryBtn.style.opacity = isPinned ? '1' : '0.5';
    els.pinCategoryBtn.onclick = () => {
      if (isPinned) {
        state.pinnedCats = state.pinnedCats.filter(p => JSON.stringify(p) !== JSON.stringify(path));
        showToast('📌 ピン留めを解除しました');
      } else {
        state.pinnedCats.push(path);
        showToast('📌 ピン留めしました');
      }
      savePins();
      renderFavTree();
      navigateTo(path);
    };
  } else {
    els.pinCategoryBtn.classList.add('hidden');
  }
}

function findTreeNode(path) {
  // ツリーノードは section-body の中にあるため、そこから検索開始
  const root = els.treeNav.querySelector('.section-body') || els.treeNav;
  let cur = root;
  for (const key of path) {
    const found = Array.from(cur.children).find(n => n.dataset?.key === key);
    if (!found) return null;
    const childWrap = found.querySelector('.tree-children');
    if (!childWrap) return found;   // 末端ノード
    cur = childWrap;
  }
  return cur?.closest?.('.tree-node') || null;
}

function expandAncestors(nodeEl) {
  let cur = nodeEl.parentElement;
  while (cur && cur !== els.treeNav) {
    if (cur.classList.contains('tree-children')) {
      cur.classList.add('open');
      const label = cur.previousElementSibling;
      if (label?.classList.contains('tree-label')) label.classList.add('open');
    }
    cur = cur.parentElement;
  }
}

// ── Breadcrumb ──────────────────────────────────
function renderBreadcrumb(path) {
  while (els.breadcrumb.children.length > 1) {
    els.breadcrumb.removeChild(els.breadcrumb.lastChild);
  }
  path.forEach((key, i) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '›';
    els.breadcrumb.appendChild(sep);

    const item = document.createElement('span');
    item.className = 'breadcrumb-item' + (i === path.length - 1 ? ' current' : '');
    item.textContent = translateCategory(key);
    item.title = key;
    if (i < path.length - 1) {
      item.addEventListener('click', () => navigateTo(path.slice(0, i + 1)));
    }
    els.breadcrumb.appendChild(item);
  });
}

// ── Content Rendering ───────────────────────────
function getNodeAt(path) {
  let cur = state.tree;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[key];
  }
  return cur;
}

function collectItems(node) {
  const subcats = [], tags = [];
  if (!node || typeof node !== 'object') return { subcats, tags };
  for (const [key, val] of Object.entries(node)) {
    if (key === 'self' || val === null) continue;
    if (typeof val === 'string') {
      tags.push({ name: key, url: val });
    } else if (typeof val === 'object') {
      if (val.self && typeof val.self === 'string') tags.push({ name: key, url: val.self });
      subcats.push({ name: key, node: val });
    }
  }
  return { subcats, tags };
}

function getAllTagsDeep(node, _seen = new WeakSet()) {
  const tags = [];
  if (!node || typeof node !== 'object') return tags;
  if (_seen.has(node)) return tags;
  _seen.add(node);
  for (const [key, val] of Object.entries(node)) {
    if (key === 'self' || val === null) continue;
    if (typeof val === 'string') tags.push({ name: key, url: val });
    else if (typeof val === 'object') {
      if (val.self && typeof val.self === 'string') tags.push({ name: key, url: val.self });
      tags.push(...getAllTagsDeep(val, _seen));
    }
  }
  return tags;
}

function renderContent(path) {
  els.welcomeState.classList.add('hidden');
  els.tagListSection.classList.remove('hidden');

  const node = getNodeAt(path);
  const { subcats } = collectItems(node);
  els.categoryTitle.textContent = translateCategory(path[path.length - 1] || 'Root');
  els.categoryTitle.title = path[path.length - 1] || 'Root';

  els.subcatChips.innerHTML = '';

  const allTagsDeep = getAllTagsDeep(node);

  const catKey = path[path.length - 1];
  if (catKey && state.tagMeta.has(catKey)) {
    const alreadyListed = allTagsDeep.some(t => t.name === catKey);
    if (!alreadyListed) {
      const nodeInfo = state.tagNodes.get(catKey);
      allTagsDeep.unshift({ name: catKey, url: nodeInfo?.url || '' });
    }
  }

  renderTagGrid(allTagsDeep, subcats, path);
}

// Return the set of active filter values from the checkboxes.
// Empty set means "no filter selected" → show all.
function getActiveFilters() {
  const s = new Set();
  els.filterCheckboxes().forEach(cb => { if (cb.checked) s.add(cb.value); });
  return s;
}

const FILTER_TOTAL = 7; // fav + 6 categories
const KNOWN_CATS = new Set([0, 1, 3, 4, 5]);

function applyTagFilter(tags) {
  const active = getActiveFilters();
  if (active.size === 0 || active.size === FILTER_TOTAL) return tags;
  return tags.filter(t => {
    const meta = state.tagMeta.get(t.name);
    const cat  = meta?.category;
    if (active.has('fav')   && state.favTags.has(t.name))               return true;
    if (active.has('0')     && cat === 0)                                return true;
    if (active.has('1')     && cat === 1)                                return true;
    if (active.has('3')     && cat === 3)                                return true;
    if (active.has('4')     && cat === 4)                                return true;
    if (active.has('5')     && cat === 5)                                return true;
    if (active.has('other') && (cat == null || !KNOWN_CATS.has(cat)))    return true;
    return false;
  });
}

function updateFilterBadge() {
  const active = getActiveFilters();
  const partial = active.size > 0 && active.size < FILTER_TOTAL;
  els.filterActiveBadge.textContent = active.size;
  els.filterActiveBadge.classList.toggle('hidden', !partial);
  els.filterMenuBtn.classList.toggle('filter-active', partial);
}

function saveFilterState() {
  const vals = [];
  els.filterCheckboxes().forEach(cb => { if (cb.checked) vals.push(cb.value); });
  localStorage.setItem('tagFilter', JSON.stringify(vals));
}

function renderTagGrid(tags, subcats, path) {
  const minCount  = state.minPostCount;
  const sort      = els.sortSelect.value;

  let allTags = [...tags];

  allTags = applyTagFilter(allTags);

  if (minCount > 0) {
    allTags = allTags.filter(t => {
      const meta = state.tagMeta.get(t.name);
      return meta ? meta.count >= minCount : true;
    });
  }

  // Sort
  if (sort === 'alpha') {
    allTags.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'post-desc') {
    allTags.sort((a, b) => getCount(b.name) - getCount(a.name));
  } else if (sort === 'post-asc') {
    allTags.sort((a, b) => getCount(a.name) - getCount(b.name));
  }

  // Deduplicate
  const seen = new Set();
  allTags = allTags.filter(t => seen.has(t.name) ? false : (seen.add(t.name), true));

  // Pin exact match to front in related tag mode
  if (state.currentPath[0] === '__search_result__') {
    const exactTerm = state.currentPath[1];
    const exactIdx = allTags.findIndex(t => t.name === exactTerm);
    if (exactIdx > 0) {
      const [exactTag] = allTags.splice(exactIdx, 1);
      allTags.unshift(exactTag);
    }
  }

  els.tagCount.textContent = `${allTags.length} tags`;
  state.renderOffset = 0;
  state._currentTags = allTags;

  els.tagsGrid.innerHTML = '';

  // Up One Level card
  if (path && path.length > 0 && path[0] !== '__fav_tags__') {
    els.tagsGrid.appendChild(createUpCard(path));
  }

  // Render subcats as cards first
  subcats.forEach(sc => {
    els.tagsGrid.appendChild(createSubcatCard(sc, path));
  });

  appendTagBatch();
}

// ── Up Card ─────────────────────────────────────
function createUpCard(path) {
  const card = document.createElement('div');
  card.className = 'tag-card subcat-card';
  card.style.setProperty('--cat-color', 'var(--text-muted)');

  const name = document.createElement('span');
  name.className = 'tag-name';
  name.textContent = '📁 .. (上の階層へ戻る)';

  card.appendChild(name);
  card.addEventListener('click', () => {
    if (path[0] === '__search_result__') {
      // 単一タグの検索結果 → そのタグを内包するカテゴリへ
      // ツリー未登録の場合は root へ
      const bc = state.tagNodes.get(path[1])?.breadcrumb ?? [];
      navigateTo(bc.length > 0 ? bc : []);
    } else if (path[0] === '__search_query__') {
      // フリーワード検索結果 → 上位カテゴリが不定なので root へ
      navigateTo([]);
    } else {
      navigateTo(path.slice(0, -1));
    }
  });
  return card;
}

function createSubcatCard(sc, path) {
  const card = document.createElement('div');
  card.className = 'tag-card subcat-card';
  card.style.setProperty('--cat-color', 'var(--accent)');

  const name = document.createElement('span');
  name.className = 'tag-name';
  name.textContent = '📁 ' + translateCategory(sc.name);
  name.title = sc.name;

  const count = document.createElement('span');
  count.className = 'tag-post-count';
  count.textContent = countLeaves(sc.node);

  card.appendChild(name);
  card.appendChild(count);
  card.addEventListener('click', () => navigateTo([...path, sc.name]));
  return card;
}

function getCount(name) {
  return state.tagMeta.get(name)?.count ?? 0;
}

const _wordTipCache = new Map();
function getWordTooltip(word) {
  if (_wordTipCache.has(word)) return _wordTipCache.get(word);

  const exactJa = state.translations.get(word);
  if (exactJa) {
    const tip = exactJa;
    _wordTipCache.set(word, tip);
    return tip;
  }

  let bestName = null, bestCount = -1;
  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern;
  try { pattern = new RegExp(`(^|_)${escapedWord}(_|$)`); }
  catch (_) { _wordTipCache.set(word, ''); return ''; }
  for (const [name, meta] of state.tagMeta.entries()) {
    if (pattern.test(name) && meta.count > bestCount) {
      bestCount = meta.count;
      bestName  = name;
    }
  }

  let tip = '';
  if (bestName) {
    const bestJa = state.translations.get(bestName);
    tip = bestJa ? `例: ${bestName}（${bestJa}）` : `例: ${bestName}`;
  }
  _wordTipCache.set(word, tip);
  return tip;
}

function appendTagBatch() {
  const allTags = state._currentTags || [];
  if (state.renderOffset >= allTags.length) return;

  const slice = allTags.slice(state.renderOffset, state.renderOffset + state.BATCH);

  const frag = document.createDocumentFragment();
  slice.forEach(tag => {
    try {
      frag.appendChild(createTagCard(tag));
    } catch (e) {
      console.warn('[TagExplorer] createTagCard failed for:', tag.name, e.message);
    }
  });
  els.tagsGrid.appendChild(frag);
  state.renderOffset += slice.length;

  let sentinel = els.tagsGrid.querySelector('.scroll-sentinel');
  if (sentinel) sentinel.remove();

  if (state.renderOffset < allTags.length) {
    sentinel = document.createElement('div');
    sentinel.className = 'scroll-sentinel';
    els.tagsGrid.appendChild(sentinel);
    state.observer.observe(sentinel);
  }
}

function createTagCard(tag) {
  const meta = state.tagMeta.get(tag.name);
  const card = document.createElement('div');
  card.className = 'tag-card';
  card.dataset.tagName = tag.name;

  const catColor = getCategoryColor(meta?.category);
  card.style.setProperty('--cat-color', catColor);

  const jaText = state.translations.get(tag.name);

  if (state.favTags.has(tag.name)) {
    const indicator = document.createElement('div');
    indicator.className = 'fav-indicator';
    card.appendChild(indicator);
  }

  const name = document.createElement('span');
  name.className = 'tag-name';
  name.title = jaText ? `${tag.name}\n${jaText}` : tag.name;

  const words = tag.name.split('_');
  words.forEach((word, index) => {
    const wordSpan = document.createElement('span');
    wordSpan.className = 'tag-word-link';
    wordSpan.textContent = word;

    if (words.length > 1) {
      const tip = getWordTooltip(word);
      if (tip) wordSpan.title = tip;
    }

    wordSpan.addEventListener('click', e => {
      e.stopPropagation();
      navigateTo(['__search_result__', word]);
    });
    name.appendChild(wordSpan);

    if (index < words.length - 1) {
      const underSpan = document.createElement('span');
      underSpan.textContent = '_';
      underSpan.className = 'tag-word-sep';
      name.appendChild(underSpan);
    }
  });

  if (jaText) {
    const jaSpan = document.createElement('span');
    jaSpan.className = 'tag-ja';
    jaSpan.textContent = `(${jaText})`;
    name.appendChild(document.createTextNode(' '));
    name.appendChild(jaSpan);
  }

  const count = document.createElement('span');
  count.className = 'tag-post-count';
  count.textContent = meta ? formatCount(meta.count) : '';

  const actions = document.createElement('div');
  actions.className = 'tag-actions';

  const favBtn = document.createElement('button');
  favBtn.className = 'tag-btn';
  favBtn.textContent = state.favTags.has(tag.name) ? '♥' : '♡';
  favBtn.title = 'お気に入り';
  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (state.favTags.has(tag.name)) state.favTags.delete(tag.name);
    else state.favTags.add(tag.name);
    saveFavs();
    renderFavTree();

    if (state.favTags.has(tag.name)) {
      favBtn.textContent = '♥';
      if (!card.querySelector('.fav-indicator')) {
        const ind = document.createElement('div');
        ind.className = 'fav-indicator';
        card.appendChild(ind);
      }
    } else {
      favBtn.textContent = '♡';
      card.querySelector('.fav-indicator')?.remove();
    }
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'tag-btn';
  copyBtn.textContent = '📋';
  copyBtn.title = 'コピー';
  copyBtn.addEventListener('click', e => {
    e.stopPropagation();
    copyToClipboard(formatTagForExport(tag.name, { withComma: true }));
  });

  const wikiBtn = document.createElement('button');
  wikiBtn.className = 'tag-btn';
  wikiBtn.textContent = '↗';
  wikiBtn.title = 'Wiki';

  // Desktop: hover shows preview, click opens link
  wikiBtn.addEventListener('mouseenter', e => { if (!isCoarsePointer()) showWikiPreview(e, tag, meta); });
  wikiBtn.addEventListener('mousemove',  e => { if (!isCoarsePointer()) repositionWikiPreview(e); });
  wikiBtn.addEventListener('mouseleave',   () => { if (!isCoarsePointer()) hideWikiPreview(); });

  // Click: desktop=open link / mobile=1st tap preview, 2nd tap open
  wikiBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (isCoarsePointer()) {
      if (wikiPreviewEl._activeTag === tag.name && wikiPreviewEl.style.display === 'block') {
        openWikiLink(tag);
        hideWikiPreview();
      } else {
        showWikiPreview(e, tag, meta);
        wikiPreviewEl._activeTag = tag.name;
      }
    } else {
      openWikiLink(tag);
    }
  });

  actions.appendChild(favBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(wikiBtn);
  card.appendChild(name);
  card.appendChild(count);
  card.appendChild(actions);

  // ── Long press / right-click → context menu ──
  const tagBreadcrumb = state.tagNodes.get(tag.name)?.breadcrumb ?? [];
  let _lpTimer = null;
  let _lpStartX = 0, _lpStartY = 0;
  let _suppressClick = false;

  card.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== undefined) return; // 左ボタン以外は無視（右クリックは contextmenu で処理）
    _lpStartX = e.clientX; _lpStartY = e.clientY;
    document.body.classList.add('dte-no-select'); // 長押し開始時からテキスト選択を抑制
    _lpTimer = setTimeout(() => {
      _suppressClick = true;
      showCardContextMenu(e.clientX, e.clientY, tag.name, tagBreadcrumb);
      // showCardContextMenu 内でも dte-no-select を付与するが、
      // タイマー発火前に pointerup → _cancelLP が走っても安全なよう二重管理
    }, 500);
  });
  const _cancelLP = () => {
    clearTimeout(_lpTimer); _lpTimer = null;
    // メニューが表示されていなければ選択抑制を解除
    if (els.cardContextMenu.classList.contains('hidden')) {
      document.body.classList.remove('dte-no-select');
    }
  };
  card.addEventListener('pointermove', e => {
    // 8px 以上動いたらキャンセル
    if (Math.hypot(e.clientX - _lpStartX, e.clientY - _lpStartY) > 8) _cancelLP();
  });
  card.addEventListener('pointerup',    _cancelLP);
  card.addEventListener('pointerleave', _cancelLP);

  // デスクトップ右クリック
  card.addEventListener('contextmenu', e => {
    e.preventDefault();
    _cancelLP();
    showCardContextMenu(e.clientX, e.clientY, tag.name, tagBreadcrumb);
  });

  card.addEventListener('click', () => {
    if (_suppressClick) { _suppressClick = false; return; }
    toggleTagInScratchpad(tag.name);
  });
  return card;
}

function getCategoryColor(cat) {
  const map = { 0: 'var(--cat-0)', 1: 'var(--cat-1)', 3: 'var(--cat-3)', 4: 'var(--cat-4)', 5: 'var(--cat-5)' };
  return map[cat] ?? 'var(--cat-x)';
}

function formatCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// ── Search ──────────────────────────────────────
function getSearchQueryTags(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const minCount = state.minPostCount;
  const results = [];
  for (const [tagName, meta] of state.tagMeta.entries()) {
    if (minCount > 0 && meta.count < minCount) continue;
    const jaText = state.translations.get(tagName) || '';
    const nameL = tagName.toLowerCase();
    const jaL   = jaText.toLowerCase();
    if (tokens.every(t => nameL.includes(t) || jaL.includes(t))) {
      results.push({ name: tagName, url: state.tagNodes.get(tagName)?.url || '' });
    }
  }
  return results;
}

function getRelatedTags(tagName) {
  const parts = tagName.split('_');
  function findTags(str) {
    const res = [];
    for (const t of state.tagMeta.keys()) {
      if (t.includes(str)) res.push(t);
    }
    return res;
  }

  let results = findTags(tagName);
  if (results.length > 5 || parts.length === 1) return results.slice(0, 100);

  const set = new Set(results);
  const suffix = parts.slice(1).join('_');
  const prefix = parts.slice(0, -1).join('_');

  if (suffix.length > 3) findTags(suffix).forEach(t => set.add(t));
  if (prefix.length > 3) findTags(prefix).forEach(t => set.add(t));

  if (set.size < 10) {
    const majorWord = parts.reduce((a, b) => a.length > b.length ? a : b);
    if (majorWord.length > 3) findTags(majorWord).forEach(t => set.add(t));
  }

  return Array.from(set).sort((a, b) => getCount(b) - getCount(a)).slice(0, 100);
}

function handleSearch(query, isAI = false) {
  query = query.trim();
  if (!query) { els.searchOverlay.classList.add('hidden'); return; }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const minCount = state.minPostCount;

  const results = [];
  for (const [tagName, meta] of state.tagMeta.entries()) {
    if (minCount > 0 && meta.count < minCount) continue;
    const jaText = state.translations.get(tagName) || '';
    const nameL = tagName.toLowerCase();
    const jaL   = jaText.toLowerCase();
    if (tokens.every(t => nameL.includes(t) || jaL.includes(t))) {
      results.push(tagName);
      if (results.length >= 60) break;
    }
  }

  results.sort((a, b) => getCount(b) - getCount(a));

  els.searchCount.textContent = results.length;
  els.searchList.innerHTML = '';
  const frag = document.createDocumentFragment();

  results.forEach(tagName => {
    const meta = state.tagMeta.get(tagName);
    const nodeInfo = state.tagNodes.get(tagName);
    const breadcrumb = nodeInfo ? nodeInfo.breadcrumb : [];

    const li = document.createElement('li');
    li.className = 'search-result-item';

    const tagSpan = document.createElement('span');
    tagSpan.className = 'search-result-tag';
    const jaText = state.translations.get(tagName);
    let displayName = highlightMatch(tagName, tokens);
    if (jaText) displayName += ` <span class="tag-ja">(${highlightMatch(jaText, tokens)})</span>`;
    tagSpan.innerHTML = displayName;

    const pathSpan = document.createElement('span');
    pathSpan.className = 'search-result-path';
    if (breadcrumb.length > 0) {
      breadcrumb.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.textContent = ' › ';
          pathSpan.appendChild(sep);
        }
        const link = document.createElement('span');
        link.className = 'search-result-path-link';
        link.textContent = translateCategory(seg);
        link.title = seg;
        link.addEventListener('click', e => {
          e.stopPropagation();
          els.searchOverlay.classList.add('hidden');
          els.globalSearch.value = '';
          navigateTo(breadcrumb.slice(0, i + 1));
        });
        pathSpan.appendChild(link);
      });
      pathSpan.title = breadcrumb.join(' > ');
    } else {
      pathSpan.textContent = '未分類 ';
      pathSpan.style.color = 'var(--accent)';
    }

    const countSpan = document.createElement('span');
    countSpan.className = 'search-result-count';
    countSpan.textContent = meta ? formatCount(meta.count) : '';

    li.appendChild(tagSpan);
    li.appendChild(pathSpan);
    li.appendChild(countSpan);

    li.addEventListener('click', () => {
      els.searchOverlay.classList.add('hidden');
      els.globalSearch.value = '';
      navigateTo(['__search_result__', tagName]);
    });
    frag.appendChild(li);
  });

  els.searchList.appendChild(frag);
  els.searchAiBadge?.classList.toggle('hidden', !isAI);
  els.searchOverlay.classList.remove('hidden');
}

let _llmSearchAbort   = null;
let _lastAiQuery      = null; // AI翻訳で得られた翻訳済みクエリ（Enter一覧表示に使用）
let _aiOriginalQuery  = null; // 元の日本語クエリ（[+][-]再翻訳に使用）
let _aiCandidateCount = Math.max(1, Math.min(parseInt(localStorage.getItem('dte_aiCandidateCount') || '3', 10), 10));

// boot後にサイレント実行: LLMサーバーが起動中でモデルが取得できればインメモリにセット。
// モデル未設定時のみ動作し、設定はsettings.jsonに保存しない。
async function tryAutoDetectLlm() {
  if (state.llmConfig.model) return;
  try {
    const { host, port, path } = state.llmConfig;
    const params = new URLSearchParams({
      host: host || 'localhost',
      port: port || 11434,
      path: path || '/v1',
    });
    const data = await fetch(`api/llm/models?${params}`).then(r => r.json());
    if (data.models && data.models.length > 0) {
      state.llmConfig.model = data.models[0];
    }
  } catch (e) { /* LLM未起動は正常 */ }
}

// LLM出力を {ja, en} ペア配列に解析する。
// "日本語: english keyword" 形式と従来のカンマ区切り形式の両方に対応。
// "japanese: cand1 | cand2 | cand3" 形式を {ja, candidates[]} に解析。
// 従来のカンマ/改行区切り形式にもフォールバック対応。
function parseLlmOutput(raw) {
  const unescaped = raw.replace(/\\_/g, '_');
  const lines = unescaped.split('\n')
    .map(l => l.replace(/^[\d]+[.)]\s*|^[-*•]\s*/, '').trim())
    .filter(Boolean);
  const pairLines = lines.filter(l => l.includes(':'));
  if (pairLines.length >= Math.ceil(lines.length / 2)) {
    return pairLines.map(line => {
      const colonIdx = line.indexOf(':');
      const ja = line.slice(0, colonIdx).trim();
      const candidates = line.slice(colonIdx + 1)
        .split('|').map(t => t.trim()).filter(Boolean);
      return { ja, candidates: candidates.length ? candidates : [''] };
    });
  }
  return unescaped.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
    .map(en => ({ ja: '', candidates: [en] }));
}

// state.translations (tagName→ja) の逆引きMap (ja→[tagName,...]) をキャッシュ構築。
let _jaReverseMap = null;
function getJaReverseMap() {
  if (_jaReverseMap) return _jaReverseMap;
  _jaReverseMap = new Map();
  for (const [tagName, jaText] of state.translations) {
    const key = jaText.trim();
    if (!_jaReverseMap.has(key)) _jaReverseMap.set(key, []);
    _jaReverseMap.get(key).push(tagName);
  }
  return _jaReverseMap;
}

// 日本語テキストでDanbooruタグを逆引きする（投稿数最大のものを返す）。
function resolveByJa(jaWord) {
  if (!jaWord) return null;
  const reverseMap = getJaReverseMap();
  const candidates = reverseMap.get(jaWord.trim());
  if (!candidates || candidates.length === 0) return null;
  return candidates.reduce((best, name) => {
    const c = state.tagMeta.get(name)?.count ?? 0;
    return c > (state.tagMeta.get(best)?.count ?? 0) ? name : best;
  });
}

// 英語キーワードをDanbooruタグ名に解決する（日本語逆引きが失敗した場合のフォールバック）。
// 1. 完全一致 (spaces→underscores)
// 2. 全トークン一致の中で最高投稿数のタグ
// 3. フォールバック: アンダースコア正規化そのまま
function resolveToDbTag(enTerm) {
  const underscored = enTerm.toLowerCase().replace(/\s+/g, '_');
  if (state.tagMeta.has(underscored)) return underscored;
  const tokens = underscored.split('_').filter(Boolean);
  if (tokens.length > 1) {
    let best = null, bestCount = -1;
    for (const [name, meta] of state.tagMeta) {
      if (tokens.every(t => name.includes(t)) && meta.count > bestCount) {
        bestCount = meta.count;
        best = name;
      }
    }
    if (best) return best;
  }
  return underscored;
}

// ペアを解決: 日本語逆引き優先、失敗時は最初の候補から解決。
function resolvePair({ ja, candidates }) {
  return resolveByJa(ja) ?? resolveToDbTag(candidates[0] ?? '');
}

// 全候補を解決してユニークなDanbooruタグ名リストを返す。
function resolveAllCandidates({ ja, candidates }) {
  const results = [];
  const seen = new Set();
  const jaResolved = resolveByJa(ja);
  if (jaResolved) { seen.add(jaResolved); results.push(jaResolved); }
  for (const c of candidates) {
    if (!c) continue;
    const r = resolveToDbTag(c);
    if (!seen.has(r)) { seen.add(r); results.push(r); }
  }
  return results.length ? results : [resolveToDbTag(candidates[0] ?? '')];
}

// 各コンセプトの候補セットからクエリバリアント文字列の配列を生成する。
// 例: [['a','b'], ['x','y']] → ['a x', 'a y', 'b x', 'b y'] (最大16件)
function buildQueryVariants(sets) {
  let variants = [''];
  for (const cands of sets) {
    const next = [];
    for (const existing of variants) {
      for (const c of cands) {
        next.push(existing ? existing + ' ' + c : c);
      }
    }
    variants = next;
    if (variants.length > 16) { variants = variants.slice(0, 16); break; }
  }
  return variants;
}

// AI候補チップを検索オーバーレイに描画する。
function renderAiCandidates(variants, activeIdx) {
  const container = els.searchAiCandidates;
  if (!container) return;
  if (!variants || variants.length <= 1) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '';
  variants.forEach((v, i) => {
    const chip = document.createElement('button');
    chip.className = 'search-ai-chip' + (i === (activeIdx ?? 0) ? ' active' : '');
    chip.textContent = v;
    chip.addEventListener('click', () => {
      container.querySelectorAll('.search-ai-chip').forEach((c, j) => {
        c.classList.toggle('active', j === i);
      });
      _lastAiQuery = v;
      handleSearch(v, true);
    });
    container.appendChild(chip);
  });

  // [+][-] 候補数増減ボタン
  const btnMinus = document.createElement('button');
  btnMinus.className = 'search-ai-count-btn';
  btnMinus.textContent = '−';
  btnMinus.title = '候補を減らして再翻訳';
  btnMinus.disabled = _aiCandidateCount <= 1;
  btnMinus.addEventListener('click', () => {
    if (_aiOriginalQuery && _aiCandidateCount > 1)
      triggerLlmSearch(_aiOriginalQuery, _aiCandidateCount - 1);
  });

  const countLabel = document.createElement('span');
  countLabel.className = 'search-ai-count-label';
  countLabel.textContent = `×${_aiCandidateCount}`;

  const btnPlus = document.createElement('button');
  btnPlus.className = 'search-ai-count-btn';
  btnPlus.textContent = '+';
  btnPlus.title = '候補を増やして再翻訳';
  btnPlus.disabled = _aiCandidateCount >= 10;
  btnPlus.addEventListener('click', () => {
    if (_aiOriginalQuery && _aiCandidateCount < 10)
      triggerLlmSearch(_aiOriginalQuery, _aiCandidateCount + 1);
  });

  container.appendChild(btnMinus);
  container.appendChild(countLabel);
  container.appendChild(btnPlus);
  container.classList.remove('hidden');
}

// LLM出力を正規化してdisplay用文字列に変換:
//   ペア解析 → 日本語逆引き/英語解決 → replace-underscore適用 → 末尾カンマ付加
function normalizeLlmTags(raw) {
  const pairs = parseLlmOutput(raw);
  const replaceUs = els.replaceUnderscore?.checked ?? false;
  const tags = pairs.map(pair => {
    const resolved = resolvePair(pair);
    return replaceUs ? resolved.replace(/_/g, ' ') : resolved;
  });
  return tags.length ? tags.join(', ') + ',' : '';
}


async function triggerLlmSearch(query, count) {
  count = Math.max(1, Math.min(count ?? _aiCandidateCount, 10));
  if (_llmSearchAbort) _llmSearchAbort.abort();
  _llmSearchAbort = new AbortController();
  _aiOriginalQuery  = query;
  _aiCandidateCount = count;
  localStorage.setItem('dte_aiCandidateCount', count);
  const hint = els.searchEnterHint;
  if (hint) hint.textContent = '🤖 翻訳中...';
  try {
    const res = await fetch('api/ai-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: query, count }),
      signal: _llmSearchAbort.signal,
    });
    const data = await res.json();
    if (!data.tags) return;
    const pairs = parseLlmOutput(data.tags);
    // 各コンセプトの全候補を解決し、クエリバリアントを生成
    const candidateSets = pairs.map(resolveAllCandidates);
    const variants = buildQueryVariants(candidateSets);
    // 末尾に元の検索ワードを追加（重複しない場合のみ）
    if (!variants.includes(query)) variants.push(query);
    const primary = variants[0] ?? '';
    _lastAiQuery = primary;
    handleSearch(primary, true);
    renderAiCandidates(variants, 0);
  } catch (e) {
    if (e.name !== 'AbortError') {} // silent fallback
  } finally {
    if (hint) hint.textContent = '↵ Enter で一覧表示';
    _llmSearchAbort = null;
  }
}

function highlightMatch(text, tokens) {
  const textL = text.toLowerCase();
  const ranges = [];
  for (const t of tokens) {
    let idx = 0;
    while ((idx = textL.indexOf(t, idx)) !== -1) {
      ranges.push([idx, idx + t.length]);
      idx += t.length;
    }
  }
  if (ranges.length === 0) return escHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i]);
  }
  let out = '', cur = 0;
  for (const [s, e] of merged) {
    out += escHtml(text.slice(cur, s));
    out += `<mark class="search-result-mark">${escHtml(text.slice(s, e))}</mark>`;
    cur = e;
  }
  return out + escHtml(text.slice(cur));
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Scratchpad & Clipboard ──────────────────────
function formatTagForExport(tagName, { withComma = false } = {}) {
  let res = tagName.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  if (els.replaceUnderscore && els.replaceUnderscore.checked) {
    res = res.replace(/_/g, ' ');
  }
  if (withComma && els.appendComma?.checked) {
    res = res + ', ';
  }
  return res;
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showToast(`📋 コピーしました`));
  } else {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast(`📋 コピーしました`);
    } catch (error) {
      console.error('Copy failed', error);
      showToast('⚠️ コピーに失敗しました');
    } finally {
      textArea.remove();
    }
  }
}

// ソフト削除されたタグ: rawName → textarea 上のトークン文字列
const LLM_PRESETS = [
  { id: 'ollama',         label: 'Ollama',                port: 11434, path: '/v1', key: '',          supportsUnload: true  },
  { id: 'lm-studio',      label: 'LM Studio',             port: 1234,  path: '/v1', key: 'lm-studio', supportsUnload: true  },
  { id: 'text-gen-webui', label: 'text-generation-webui', port: 5000,  path: '/v1', key: '',          supportsUnload: true  },
  { id: 'koboldcpp',      label: 'KoboldCpp',             port: 5001,  path: '/v1', key: '',          supportsUnload: false },
  { id: 'llama-server',   label: 'llama.cpp server',      port: 8080,  path: '/v1', key: 'none',      supportsUnload: false },
  { id: 'custom',         label: 'カスタム',              port: null,  path: '/v1', key: '',          supportsUnload: false },
];

const _softDeleted = new Map();

function softDeleteTag(rawName, token) {
  // 削除前に「直前のタグ」を記録して元の位置を保持できるようにする
  const activeTags = parseScratchpadTags();
  const idx = activeTags.findIndex(t => t.rawName === rawName);
  const insertAfterRaw = idx > 0 ? activeTags[idx - 1].rawName : null;
  _softDeleted.set(rawName, { token, insertAfterRaw });
  toggleTagInScratchpad(rawName); // synthetic input が renderScratchpadTagList を起動
}

function undoSoftDelete(rawName) {
  const entry = _softDeleted.get(rawName);
  if (!entry) return;
  const { token: restoredToken, insertAfterRaw } = entry;
  _softDeleted.delete(rawName);

  const input = els.scratchpadInput;

  if (insertAfterRaw === null) {
    // 先頭タグだった場合: テキスト先頭に挿入
    const text = input.value;
    input.value = restoredToken + (text.trim() ? ', ' + text : '');
    input.dispatchEvent(new Event('input'));
    return;
  }

  const afterEntry = parseScratchpadTags().find(t => t.rawName === insertAfterRaw);
  if (!afterEntry) {
    toggleTagInScratchpad(rawName);
    return;
  }

  // afterEntry.token の終端にカーソルを移動し insertAtScratchpadCursor で挿入
  // → テキストを直接書き換えないので改行レイアウトが保たれる
  const text = input.value;
  let insertPos = -1;
  let offset = 0;
  for (const line of text.split('\n')) {
    let partOff = offset;
    for (const part of line.split(',')) {
      if (part.trim() === afterEntry.token) {
        insertPos = partOff + part.indexOf(afterEntry.token) + afterEntry.token.length;
        break;
      }
      partOff += part.length + 1; // +1 for ','
    }
    if (insertPos >= 0) break;
    offset += line.length + 1; // +1 for '\n'
  }

  if (insertPos >= 0) {
    input.selectionStart = input.selectionEnd = insertPos;
    insertAtScratchpadCursor(restoredToken);
  } else {
    toggleTagInScratchpad(rawName);
  }
}

function permanentDeleteTag(rawName) {
  _softDeleted.delete(rawName);
  renderScratchpadTagList();
}

function parseTags(inputEl) {
  return (inputEl?.value ?? '')
    .split(/[\n,]/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(token => {
      // export フォーマット（\( \)、スペース→_）を逆変換して raw タグ名を復元する
      const normalized = token
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/ /g, '_');
      const known = state.tagMeta.has(normalized);
      return { token, rawName: known ? normalized : token, known };
    });
}

function parseScratchpadTags() {
  return parseTags(els.scratchpadInput);
}

function createTagListItem(token, rawName, known, softDeleted) {
  const item = document.createElement('div');
  item.className = 'scratchpad-tag-item' + (softDeleted ? ' scratchpad-tag-deleted' : '');

  const nameEl = document.createElement('span');
  nameEl.className = 'scratchpad-tag-name' + (!known && !softDeleted ? ' scratchpad-tag-unknown' : '');
  nameEl.textContent = token;

  if (softDeleted) {
    nameEl.title = 'クリックで削除を取り消す';
    nameEl.addEventListener('click', () => undoSoftDelete(rawName));
  } else {
    if (known) nameEl.title = rawName;
    nameEl.addEventListener('click', () => {
      openTagDetail(rawName, state.tagNodes.get(rawName)?.breadcrumb);
    });
    if (!isCoarsePointer()) {
      nameEl.addEventListener('mouseenter', () => {
        const rect = nameEl.getBoundingClientRect();
        showWikiPreview(null, { name: rawName }, state.tagMeta.get(rawName), {
          fixedPos: {
            x: Math.max(8, rect.left - 348),
            y: Math.min(rect.top, window.innerHeight - 260),
          },
        });
      });
      nameEl.addEventListener('mouseleave', () => hideWikiPreview());
    }
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'scratchpad-tag-remove';
  removeBtn.textContent = '×';
  removeBtn.title = softDeleted ? '完全削除' : '削除';
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    softDeleted ? permanentDeleteTag(rawName) : softDeleteTag(rawName, token);
  });

  item.appendChild(nameEl);
  item.appendChild(removeBtn);
  return item;
}

function buildDisplayList() {
  const activeTags = parseScratchpadTags();
  // textarea に戻ったタグは soft-deleted から除外
  for (const { rawName } of activeTags) _softDeleted.delete(rawName);
  // アクティブタグをベースに、ソフト削除タグを元の位置に挿入してマージ
  const result = activeTags.map(t => ({ ...t, deleted: false }));
  for (const [rawName, { token, insertAfterRaw }] of _softDeleted) {
    const item = { token, rawName, known: state.tagMeta.has(rawName), deleted: true };
    if (insertAfterRaw === null) {
      result.unshift(item);
    } else {
      const afterIdx = result.findIndex(t => t.rawName === insertAfterRaw);
      afterIdx >= 0 ? result.splice(afterIdx + 1, 0, item) : result.push(item);
    }
  }
  return result;
}

function renderScratchpadTagList() {
  const list = els.scratchpadTagList;
  if (!list) return;
  list.innerHTML = '';
  for (const { token, rawName, known, deleted } of buildDisplayList()) {
    list.appendChild(createTagListItem(token, rawName, known, deleted));
  }
}

function createLlmTagListItem(token, rawName, known) {
  const item = document.createElement('div');
  item.className = 'scratchpad-tag-item';

  const nameEl = document.createElement('span');
  nameEl.className = 'scratchpad-tag-name' + (!known ? ' scratchpad-tag-unknown' : '');
  nameEl.textContent = token;
  if (known) nameEl.title = rawName;
  nameEl.addEventListener('click', () => {
    openTagDetail(rawName, state.tagNodes.get(rawName)?.breadcrumb);
  });
  if (!isCoarsePointer()) {
    nameEl.addEventListener('mouseenter', () => {
      const rect = nameEl.getBoundingClientRect();
      showWikiPreview(null, { name: rawName }, state.tagMeta.get(rawName), {
        fixedPos: {
          x: Math.max(8, rect.left - 348),
          y: Math.min(rect.top, window.innerHeight - 260),
        },
      });
    });
    nameEl.addEventListener('mouseleave', () => hideWikiPreview());
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'scratchpad-tag-remove';
  removeBtn.textContent = '×';
  removeBtn.title = '削除';
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    const input = els.llmTagOutput;
    const newText = input.value.split('\n').map(line => {
      const parts = line.split(',');
      const newParts = parts.filter(p => p.trim() !== token);
      if (newParts.length === parts.length) return line;
      const remaining = newParts.map(p => p.trim()).filter(Boolean);
      return remaining.length > 0 ? remaining.join(', ') + ', ' : '';
    }).join('\n');
    input.value = newText;
    input.dispatchEvent(new Event('input'));
  });

  item.appendChild(nameEl);
  item.appendChild(removeBtn);
  return item;
}

function renderLlmTagList() {
  const list = els.llmTagList;
  if (!list) return;
  list.innerHTML = '';
  for (const { token, rawName, known } of parseTags(els.llmTagOutput)) {
    list.appendChild(createLlmTagListItem(token, rawName, known));
  }
}

function toggleTagInScratchpad(name) {
  const tagText    = formatTagForExport(name);                    // 比較・削除用（カンマなし）
  const formatted  = formatTagForExport(name, { withComma: true }); // 挿入用（カンマあり）
  const input = els.scratchpadInput;
  const text = input.value;

  // タグが含まれているか判定（改行・カンマ両方で分割して全トークンを走査）
  const allTags = text.split(/[\n,]/).map(t => t.trim()).filter(Boolean);

  if (allTags.includes(tagText)) {
    // 削除: 行単位で処理し、対象タグが含まれる行だけを変更する
    const savedLC = getCursorLC(input);
    const newText = text.split('\n').map(line => {
      const parts = line.split(',');
      const newParts = parts.filter(t => t.trim() !== tagText);
      if (newParts.length === parts.length) return line; // 変化なし → そのまま
      // 変化あり: trimして再結合（その行のみ整形）
      const remaining = newParts.map(t => t.trim()).filter(Boolean);
      return remaining.length > 0 ? remaining.join(', ') + ', ' : '';
    }).join('\n');
    input.value = newText;
    input.dispatchEvent(new Event('input'));
    setCursorLC(input, savedLC);
    showToast(`🗑 ストック削除: ${tagText}`);
  } else {
    // 追加: カーソル位置に挿入
    insertAtScratchpadCursor(formatted);
    showToast(`📝 ストック追加: ${tagText}`);
    addHistoryStock(name); // ← record in history
  }

}

function showToast(msg, duration = 2000) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(els.toast._timer);
  els.toast._timer = setTimeout(() => els.toast.classList.remove('show'), duration);
}

// ── Scratchpad collapse ─────────────────────────
let scratchpadExpanded = true;

function initSettingsModal() {
  // プリセット選択肢を生成
  LLM_PRESETS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    els.llmPresetSelect?.appendChild(opt);
  });

  // 現在のフォーム値をクエリパラメータ化（保存前テスト用）
  function llmQueryParams() {
    return '?' + new URLSearchParams({
      host: els.llmHost?.value.trim()  || 'localhost',
      port: els.llmPort?.value         || 11434,
      path: els.llmPath?.value.trim()  || '/v1',
    }).toString();
  }

  function setNote(el, msg, type = '') {
    if (!el) return;
    el.textContent = msg;
    el.className = 'settings-note' + (type ? ' ' + type : '');
  }

  function clearNotes() {
    [els.llmModelNote, els.llmTestNote, els.llmUnloadNote].forEach(el => setNote(el, ''));
  }

  function updateUnloadVisibility() {
    const preset = LLM_PRESETS.find(p => p.id === els.llmPresetSelect?.value);
    els.llmUnloadRow?.classList.toggle('hidden', !preset?.supportsUnload);
  }

  function populateModelSelect(models, selectedValue) {
    const sel = els.llmModelSelect;
    if (!sel) return;
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '-- モデルを選択 --';
    sel.appendChild(placeholder);
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.value = selectedValue;
  }

  function openSettings() {
    const c = state.llmConfig;
    if (els.llmPresetSelect) els.llmPresetSelect.value = c.preset || 'ollama';
    if (els.llmHost)         els.llmHost.value         = c.host   || 'localhost';
    if (els.llmPort)         els.llmPort.value         = c.port   || 11434;
    if (els.llmPath)         els.llmPath.value         = c.path   || '/v1';
    if (els.llmApiKey)       els.llmApiKey.value       = c.apiKey || '';
    if (els.llmModelSelect)  populateModelSelect([...(c.model ? [c.model] : [])], c.model || '');
    updateUnloadVisibility();
    // CSV フィールド
    const isA1111 = _mode === 'a1111';
    els.settingsCsvA1111Note?.classList.toggle('hidden', !isA1111);
    els.settingsCsvFields?.classList.toggle('hidden', isA1111);
    if (!isA1111) {
      fetch('api/settings').then(r => r.json()).then(d => {
        if (els.csvTagPath) els.csvTagPath.value = d.tagCsv || '';
        if (els.csvJaPath)  els.csvJaPath.value  = d.jaCsv  || '';
      }).catch(() => {});
    }
    clearNotes();
    els.settingsOverlay?.classList.remove('hidden');
  }

  function closeSettings() {
    els.settingsOverlay?.classList.add('hidden');
  }

  // プリセット変更 → 接続先を自動補完
  els.llmPresetSelect?.addEventListener('change', () => {
    const preset = LLM_PRESETS.find(p => p.id === els.llmPresetSelect.value);
    if (preset && preset.id !== 'custom') {
      if (preset.port && els.llmPort)   els.llmPort.value   = preset.port;
      if (preset.path && els.llmPath)   els.llmPath.value   = preset.path;
      if (preset.key  && els.llmApiKey) els.llmApiKey.value = preset.key;
    }
    updateUnloadVisibility();
    clearNotes();
  });

  // モデル一覧取得
  els.llmFetchModelsBtn?.addEventListener('click', async () => {
    setNote(els.llmModelNote, '取得中...');
    try {
      const data = await fetch('api/llm/models' + llmQueryParams()).then(r => r.json());
      if (data.error) throw new Error(data.error);
      const currentModel = els.llmModelSelect?.value || state.llmConfig.model || '';
      populateModelSelect(data.models, currentModel);
      setNote(els.llmModelNote, `${data.models.length} 件取得`, 'ok');
    } catch (e) {
      setNote(els.llmModelNote, `取得失敗: ${e.message}`, 'error');
    }
  });

  // 接続テスト
  els.llmTestBtn?.addEventListener('click', async () => {
    setNote(els.llmTestNote, 'テスト中...');
    try {
      const data = await fetch('api/llm/models' + llmQueryParams()).then(r => r.json());
      if (data.error) throw new Error(data.error);
      setNote(els.llmTestNote, `● 接続OK (モデル ${data.models.length} 件)`, 'ok');
    } catch (e) {
      setNote(els.llmTestNote, `✕ 接続失敗: ${e.message}`, 'error');
    }
  });

  // モデルアンロード
  els.llmUnloadBtn?.addEventListener('click', async () => {
    setNote(els.llmUnloadNote, 'アンロード中...');
    try {
      const data = await fetch('api/llm/unload', { method: 'POST' }).then(r => r.json());
      if (!data.ok) throw new Error(data.message || 'unknown error');
      setNote(els.llmUnloadNote, 'アンロード完了', 'ok');
    } catch (e) {
      setNote(els.llmUnloadNote, `失敗: ${e.message}`, 'error');
    }
  });

  // 保存
  els.settingsSaveBtn?.addEventListener('click', async () => {
    const llm = {
      preset:  els.llmPresetSelect?.value || 'ollama',
      host:    els.llmHost?.value.trim()  || 'localhost',
      port:    parseInt(els.llmPort?.value) || 11434,
      path:    els.llmPath?.value.trim()  || '/v1',
      apiKey:  els.llmApiKey?.value.trim() || '',
      model:   els.llmModelSelect?.value || '',
      timeout: state.llmConfig.timeout || 30,
    };
    const body = { llm };
    if (_mode !== 'a1111') {
      body.tagCsv = els.csvTagPath?.value.trim() || '';
      body.jaCsv  = els.csvJaPath?.value.trim()  || '';
    }
    try {
      const data = await fetch('api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!data.ok) throw new Error('save failed');
      Object.assign(state.llmConfig, llm);
      closeSettings();
      showToast('⚙ 設定を保存しました');
    } catch (e) {
      showToast('⚠️ 保存に失敗しました: ' + e.message);
    }
  });

  els.settingsBtn?.addEventListener('click', openSettings);
  els.settingsCloseBtn?.addEventListener('click', closeSettings);
  els.settingsCancelBtn?.addEventListener('click', closeSettings);
  els.settingsOverlay?.addEventListener('click', e => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
}

function initScratchpadTabs() {
  const tabs = document.querySelectorAll('.scratchpad-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      els.tabPanelPrompt?.classList.toggle('hidden', target !== 'prompt');
      els.tabPanelLlm?.classList.toggle('hidden', target !== 'llm');
      const promptOnly = [els.scratchpadFormatBtn, els.scratchpadCopy, els.scratchpadClear];
      promptOnly.forEach(el => el?.classList.toggle('hidden', target !== 'prompt'));
      const llmOnly = [els.llmConvertBtn, els.llmCopyBtn, els.llmClearBtn];
      llmOnly.forEach(el => el?.classList.toggle('hidden', target !== 'llm'));
    });
  });
}

function initLlmConvert() {
  const btn = els.llmConvertBtn;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const text = els.llmJpInput?.value.trim();
    if (!text) { showToast('日本語テキストを入力してください'); return; }
    const label = btn.querySelector('.btn-label');
    const origText = label?.textContent ?? '変換';
    btn.disabled = true;
    if (label) label.textContent = '変換中...';
    try {
      const res = await fetch('api/ai-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (els.llmTagOutput) {
        els.llmTagOutput.value = normalizeLlmTags(data.tags);
        els.llmTagOutput.dispatchEvent(new Event('input'));
      }
    } catch (e) {
      showToast(`変換失敗: ${e.message}`);
    } finally {
      btn.disabled = false;
      if (label) label.textContent = origText;
    }
  });

  // LLMタブ: コピーボタン（変換結果をコピー）
  els.llmCopyBtn?.addEventListener('click', () => {
    const val = els.llmTagOutput?.value.trim();
    if (!val) { showToast('コピーするタグがありません'); return; }
    copyToClipboard(val);
  });

  // LLMタブ: クリアボタン（入力・出力両方クリア）
  els.llmClearBtn?.addEventListener('click', () => {
    if (els.llmJpInput)    els.llmJpInput.value    = '';
    if (els.llmTagOutput)  els.llmTagOutput.value   = '';
    renderLlmTagList();
    showToast('🗑 クリアしました');
  });

  // 検索: LLM強制翻訳ボタン
  els.searchLlmBtn?.addEventListener('click', () => {
    const query = els.globalSearch.value.trim();
    if (!query) { showToast('検索キーワードを入力してください'); return; }
    triggerLlmSearch(query);
  });
}

function initScratchpadToggle() {
  const btn = els.scratchpadToggle;
  const pad = $('scratchpad');
  if (!btn || !pad) return;

  // Restore state
  const savedCollapsed = localStorage.getItem('scratchpadCollapsed') === 'true';
  if (savedCollapsed) {
    pad.classList.add('collapsed');
    btn.textContent = '▲';
    btn.title = 'スクラッチパッドを開く';
    scratchpadExpanded = false;
  }

  btn.addEventListener('click', () => {
    scratchpadExpanded = !scratchpadExpanded;
    pad.classList.toggle('collapsed', !scratchpadExpanded);
    btn.textContent = scratchpadExpanded ? '▼' : '▲';
    btn.title = scratchpadExpanded ? 'スクラッチパッドを折りたたむ' : 'スクラッチパッドを開く';
    localStorage.setItem('scratchpadCollapsed', String(!scratchpadExpanded));
  });
}

// ── Scratchpad Resizer ──────────────────────────
function initScratchpadResizer() {
  const handle = document.getElementById('scratchpad-resizer');
  const pad    = document.getElementById('scratchpad');
  if (!handle || !pad) return;

  // 起動時に保存サイズを復元
  const saved = parseInt(localStorage.getItem('scratchpadHeight'), 10);
  if (!isNaN(saved)) pad.style.height = saved + 'px';

  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = pad.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    // 上にドラッグ → scratchpad が高くなる
    const delta = e.clientY - startY;
    const h = Math.max(60, Math.min(600, startH - delta));
    pad.style.height = h + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    localStorage.setItem('scratchpadHeight', pad.offsetHeight);
  });
}

// ── Sidebar Resizer ─────────────────────────────
function initResizer() {
  let dragging = false, startX = 0, startW = 0;
  els.resizer.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = els.sidebar.offsetWidth;
    els.resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(480, startW + e.clientX - startX));
    els.sidebar.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    els.resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('sidebarWidth', els.sidebar.offsetWidth);
  });
}

// ── Mobile sidebar init ─────────────────────────
function initMobileSidebar() {
  if (els.mobileMenuBtn) {
    els.mobileMenuBtn.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-open');
    });
  }
  if (els.sidebarOverlay) {
    els.sidebarOverlay.addEventListener('click', () => {
      closeSidebar();
    });
  }
  if (els.sidebarCloseBtn) {
    els.sidebarCloseBtn.addEventListener('click', () => {
      closeSidebar();
    });
  }
}

// ── Re-render Helper ────────────────────────────
function rerenderCurrent() {
  if (state.currentPath.length === 0) return;
  const isSpecial = state.currentPath[0] === '__search_result__'
                 || state.currentPath[0] === '__fav_tags__'
                 || state.currentPath[0] === '__search_query__';
  if (isSpecial) navigateTo(state.currentPath);
  else renderContent(state.currentPath);
}

// ── Event Listeners ─────────────────────────────
els.expandAll.addEventListener('click', () => {
  // Auto-expand the category section if it is collapsed
  if (state.sectionCollapsed.tree) {
    state.sectionCollapsed.tree = false;
    saveSectionCollapsed();
    const treeHeader = els.treeNav.querySelector('.sidebar-section-header--toggle');
    const treeBody   = els.treeNav.querySelector('.section-body');
    if (treeHeader) treeHeader.querySelector('.section-chevron')?.classList.add('open');
    if (treeBody)   treeBody.style.display = '';
  }
  document.querySelectorAll('#tree-nav .tree-children').forEach(el => el.classList.add('open'));
  document.querySelectorAll('#tree-nav .tree-label').forEach(el => {
    if (el.querySelector('.tree-chevron')) el.classList.add('open');
  });
});

els.collapseAll.addEventListener('click', () => {
  document.querySelectorAll('#tree-nav .tree-children').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('#tree-nav .tree-label').forEach(el => el.classList.remove('open'));
});

els.sortSelect.addEventListener('change', () => {
  localStorage.setItem('sortSelect', els.sortSelect.value);
  rerenderCurrent();
});

// ── Filter menu ─────────────────────────────────
const filterDrop = els.filterMenuDropdown;

els.filterMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = filterDrop.classList.toggle('hidden');
  els.filterMenuBtn.setAttribute('aria-expanded', String(!open));
  if (!open) {
    const rect = els.filterMenuBtn.getBoundingClientRect();
    filterDrop.style.top   = (rect.bottom + 4) + 'px';
    filterDrop.style.right = (window.innerWidth - rect.right) + 'px';
  }
});

document.addEventListener('click', e => {
  if (!filterDrop.classList.contains('hidden') &&
      !filterDrop.contains(e.target) &&
      e.target !== els.filterMenuBtn) {
    filterDrop.classList.add('hidden');
    els.filterMenuBtn.setAttribute('aria-expanded', 'false');
  }
});

els.filterCheckboxes().forEach(cb => {
  cb.addEventListener('change', () => {
    updateFilterBadge();
    saveFilterState();
    rerenderCurrent();
  });
});

els.filterClearBtn.addEventListener('click', () => {
  els.filterCheckboxes().forEach(cb => { cb.checked = false; });
  updateFilterBadge();
  saveFilterState();
  rerenderCurrent();
});

// View mode toggle
const CARD_SIZE_CLASSES = ['card-size-s', 'card-size-m', 'card-size-l'];

function applyCardSize(value) {
  const idx = Number(value);
  CARD_SIZE_CLASSES.forEach((cls, i) => {
    els.tagsGrid.classList.toggle(cls, i === idx);
  });
}

function syncCardSizeWrap(mode) {
  if (els.cardSizeWrap) {
    els.cardSizeWrap.classList.toggle('hidden', mode === 'list');
  }
}

const viewMode = localStorage.getItem('viewMode') || 'list';
els.viewModeSelect.value = viewMode;
if (viewMode === 'list') {
  els.tagsGrid.classList.add('list-view');
} else {
  els.tagsGrid.classList.remove('list-view');
}
syncCardSizeWrap(viewMode);

// Card size slider init
const savedCardSize = localStorage.getItem('cardSize') ?? '1';
if (els.cardSizeSlider) {
  els.cardSizeSlider.value = savedCardSize;
}
applyCardSize(savedCardSize);

els.viewModeSelect.addEventListener('change', e => {
  const mode = e.target.value;
  localStorage.setItem('viewMode', mode);
  if (mode === 'list') els.tagsGrid.classList.add('list-view');
  else els.tagsGrid.classList.remove('list-view');
  syncCardSizeWrap(mode);
});

if (els.cardSizeSlider) {
  els.cardSizeSlider.addEventListener('input', e => {
    const val = e.target.value;
    localStorage.setItem('cardSize', val);
    applyCardSize(val);
  });
}

// Scratchpad Settings
if (els.replaceUnderscore) {
  els.replaceUnderscore.checked = localStorage.getItem('replaceUnderscore') === 'true';
  els.replaceUnderscore.addEventListener('change', e => {
    localStorage.setItem('replaceUnderscore', e.target.checked);
  });
}
if (els.appendComma) {
  // デフォルト ON（localStorage に明示的に 'false' が保存されている場合のみ OFF）
  els.appendComma.checked = localStorage.getItem('appendComma') !== 'false';
  els.appendComma.addEventListener('change', e => {
    localStorage.setItem('appendComma', e.target.checked);
  });
}

// Theme toggle — shared logic used by both header checkbox and sidebar button
function setTheme(light) {
  document.body.classList.toggle('light-theme', light);
  localStorage.setItem('theme', light ? 'light' : 'dark');
  // Sync header checkbox
  if (els.themeToggle) els.themeToggle.checked = light;
  // Sync sidebar button label/icon
  const sidebarBtn = document.getElementById('sidebar-theme-btn');
  if (sidebarBtn) {
    sidebarBtn.querySelector('.sidebar-theme-icon').textContent  = light ? '☽' : '☀';
    sidebarBtn.querySelector('.sidebar-theme-label').textContent = light ? 'ダークモードに切り替え' : 'ライトモードに切り替え';
  }
}

// Apply saved theme on load
setTheme(localStorage.getItem('theme') === 'light');

// Header checkbox
els.themeToggle.addEventListener('change', e => setTheme(e.target.checked));

// Sidebar footer button (mobile)
document.getElementById('sidebar-theme-btn')?.addEventListener('click', () => {
  setTheme(!document.body.classList.contains('light-theme'));
});

// Restore additional settings on startup
{
  const savedSort = localStorage.getItem('sortSelect');
  if (savedSort) els.sortSelect.value = savedSort;

  const savedFilter = localStorage.getItem('tagFilter');
  if (savedFilter) {
    try {
      const vals = JSON.parse(savedFilter);
      els.filterCheckboxes().forEach(cb => { cb.checked = vals.includes(cb.value); });
    } catch (_) {}
  }
  updateFilterBadge();

  const savedMinPost = localStorage.getItem('minPostFilter');
  if (savedMinPost) {
    els.minPostFilter.value = savedMinPost;
    state.minPostCount = parseInt(savedMinPost, 10) || 0;
  }

  const savedScratchpad = localStorage.getItem('scratchpad');
  if (savedScratchpad) els.scratchpadInput.value = savedScratchpad;
  renderScratchpadTagList();

  const savedSidebarW = localStorage.getItem('sidebarWidth');
  if (savedSidebarW) els.sidebar.style.width = savedSidebarW + 'px';
}

// Min post count filter — debounced
els.minPostFilter.addEventListener('input', () => {
  clearTimeout(state.filterDebounce);
  state.filterDebounce = setTimeout(() => {
    state.minPostCount = parseInt(els.minPostFilter.value, 10) || 0;
    localStorage.setItem('minPostFilter', els.minPostFilter.value);
    rerenderCurrent();
  }, 400);
});

// Search
let _llmSearchDebounce = null;
els.globalSearch.addEventListener('input', e => {
  const val = e.target.value;
  const trimmed = val.trim();

  // Cancel any pending LLM search, reset translated query and candidate chips
  clearTimeout(_llmSearchDebounce);
  if (_llmSearchAbort) { _llmSearchAbort.abort(); _llmSearchAbort = null; }
  _lastAiQuery = null; _aiOriginalQuery = null;
  if (els.searchAiCandidates) { els.searchAiCandidates.classList.add('hidden'); els.searchAiCandidates.innerHTML = ''; }

  // Normal search (150ms)
  clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(() => handleSearch(val), 150);

  // Japanese LLM auto-translate: 800ms debounce after last keystroke
  if (trimmed && /[぀-ヿ一-龯]/.test(trimmed) && state.llmConfig?.model) {
    _llmSearchDebounce = setTimeout(() => {
      const count = parseInt(els.searchCount?.textContent, 10) || 0;
      if (count === 0) triggerLlmSearch(trimmed);
    }, 800);
  }
});
els.searchClear.addEventListener('click', () => {
  els.globalSearch.value = '';
  els.searchOverlay.classList.add('hidden');
  els.searchAiBadge?.classList.add('hidden');
  clearTimeout(_llmSearchDebounce);
  if (_llmSearchAbort) { _llmSearchAbort.abort(); _llmSearchAbort = null; }
  _lastAiQuery = null; _aiOriginalQuery = null;
  if (els.searchAiCandidates) { els.searchAiCandidates.classList.add('hidden'); els.searchAiCandidates.innerHTML = ''; }
});
document.addEventListener('click', e => {
  if (!els.searchOverlay.contains(e.target) && e.target !== els.globalSearch) {
    els.searchOverlay.classList.add('hidden');
  }
});
els.globalSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    els.searchOverlay.classList.add('hidden');
    els.globalSearch.blur();
  } else if (e.key === 'Enter') {
    const query = els.globalSearch.value.trim();
    if (query) {
      addHistorySearch(query);
      els.searchOverlay.classList.add('hidden');
      els.globalSearch.value = '';
      els.globalSearch.blur();
      navigateTo(['__search_query__', _lastAiQuery ?? query]);
      _lastAiQuery = null;
    }
  }
});

// "↵ Enter で一覧表示" hint — クリックで Enter と同じ動作
els.searchEnterHint.addEventListener('click', () => {
  const query = els.globalSearch.value.trim();
  if (query) {
    addHistorySearch(query);
    els.searchOverlay.classList.add('hidden');
    els.globalSearch.value = '';
    els.globalSearch.blur();
    navigateTo(['__search_query__', _lastAiQuery ?? query]);
    _lastAiQuery = null;
  }
});

// ── Card context menu ──────────────────────────
// モジュールレベルで現在のターゲット情報を保持
let _ctxMenuTag = null;
let _ctxMenuBreadcrumb = null;

function showCardContextMenu(x, y, tagName, breadcrumb) {
  _ctxMenuTag = tagName;
  _ctxMenuBreadcrumb = breadcrumb;

  const menu = els.cardContextMenu;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.remove('hidden');
  document.body.classList.add('dte-no-select'); // メニュー表示中のテキスト選択を抑制

  // 画面端からはみ出さないよう調整（次フレームでサイズが確定してから）
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
  });
}

function hideCardContextMenu() {
  els.cardContextMenu.classList.add('hidden');
  document.body.classList.remove('dte-no-select');
  _ctxMenuTag = null;
  _ctxMenuBreadcrumb = null;
}

els.ctxDanbooruPosts.addEventListener('click', () => {
  if (_ctxMenuTag) {
    const url = 'https://danbooru.donmai.us/posts?tags=' + encodeURIComponent(_ctxMenuTag);
    window.open(url, '_blank', 'noopener');
  }
  hideCardContextMenu();
});

els.ctxDetail.addEventListener('click', () => {
  const tag = _ctxMenuTag;
  const bc  = _ctxMenuBreadcrumb;
  hideCardContextMenu();
  if (tag) openTagDetail(tag, bc);
});

// コンテキストメニュー外クリックで閉じる
document.addEventListener('pointerdown', e => {
  if (!els.cardContextMenu.classList.contains('hidden') &&
      !els.cardContextMenu.contains(e.target)) {
    hideCardContextMenu();
  }
}, { capture: true });

// Escape で閉じる
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideCardContextMenu();
    closeTagDetail();
  }
});

// Breadcrumb home
els.breadcrumbHome.addEventListener('click', () => {
  state.currentPath = [];
  document.querySelectorAll('.tree-label.active').forEach(el => el.classList.remove('active'));
  renderBreadcrumb([]);
  els.tagListSection.classList.add('hidden');
  els.welcomeState.classList.remove('hidden');
});

// Scratchpad actions
els.scratchpadCopy.addEventListener('click', () => {
  const val = els.scratchpadInput.value.trim();
  if (!val) { showToast('⚠️ コピーするタグがありません'); return; }
  copyToClipboard(val);
});

els.scratchpadClear.addEventListener('click', () => {
  els.scratchpadInput.value = '';
  localStorage.removeItem('scratchpad');
  _softDeleted.clear();
  renderScratchpadTagList();
  showToast('🗑 クリアしました');
});

// Save scratchpad content (debounced)
els.scratchpadInput.addEventListener('input', (e) => {
  // ユーザーが直接編集した場合はソフト削除を強制的に完全削除
  if (e.isTrusted && _softDeleted.size > 0) _softDeleted.clear();
  clearTimeout(els.scratchpadInput._saveTimer);
  els.scratchpadInput._saveTimer = setTimeout(() => {
    localStorage.setItem('scratchpad', els.scratchpadInput.value);
  }, 500);
  renderScratchpadTagList();
});

els.llmTagOutput?.addEventListener('input', renderLlmTagList);

els.scratchpadFormatBtn?.addEventListener('click', formatScratchpad);

// ── A1111 txt2img Integration ────────────────────────────────────────────────

// null = 未同期（初期状態）、string = 最後に同期した時点のスクラッチパッド内容
let a1111SyncedContent = null;

/** Send ボタンの変更マーカー（赤丸）を同期状態に合わせて更新する */
function updateSendBtnDirty() {
  const isDirty = a1111SyncedContent !== null &&
                  els.scratchpadInput.value !== a1111SyncedContent;
  els.a1111SendBtn.classList.toggle('has-changes', isDirty);
}

/**
 * A1111 / reForge / Forge は同一オリジン (localhost) なので window.parent.document に
 * 直接アクセスできる。旧世代 A1111 は Gradio が shadow DOM を使うため gradioApp() を
 * 経由してルートを取得する。
 */
function getParentRoot() {
  try {
    const fn = window.parent.gradioApp;
    if (typeof fn === 'function') return fn();
  } catch (_e) {}
  return window.parent.document;
}

/**
 * A1111 の指定タブ ("txt2img" / "img2img") に切り替える。
 * Gradio の .tab-nav 内ボタンをテキストマッチでクリックする。
 * タブが見つからない場合は何もしない（エラーにしない）。
 */
function switchToA1111Tab(tabName) {
  const root = getParentRoot();
  const tabNav = root.querySelector('.tab-nav');
  if (!tabNav) return;
  for (const btn of tabNav.querySelectorAll('button')) {
    if (btn.textContent.trim().toLowerCase().startsWith(tabName.toLowerCase())) {
      btn.click();
      return;
    }
  }
}

/** positive / negative それぞれの textarea を探す。見つからなければ null を返す。 */
function findPromptTextarea(target) {
  const SELECTORS = {
    positive: ['#txt2img_prompt textarea'],
    negative: ['#txt2img_neg_prompt textarea'],
  };
  const root = getParentRoot();
  for (const sel of (SELECTORS[target] || SELECTORS.positive)) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Promise ベースのモーダルダイアログを表示する。
 * @param {object} opts
 * @param {string}   opts.message   - ダイアログ本文
 * @param {Array}    opts.buttons   - [{label, value}] 。先頭がキャンセル相当
 * @param {Element}  [opts.anchorEl] - 位置の基準にするボタン要素。省略時は中央表示
 * @returns {Promise<string>}  押されたボタンの value。backdrop / ESC は 'cancel' を返す。
 */
function showDteDialog({ message, buttons, anchorEl = null }) {
  return new Promise(resolve => {
    const dialog  = els.dteDialog;
    els.dteDialogMessage.textContent = message;
    els.dteDialogButtons.innerHTML   = '';

    // 前回の位置指定をリセット
    dialog.style.margin = '';
    dialog.style.top    = '';
    dialog.style.left   = '';

    let resolved = false;
    const cleanup = value => {
      if (resolved) return;
      resolved = true;
      dialog.close();
      resolve(value);
    };

    buttons.forEach(({ label, value }, idx) => {
      const btn = document.createElement('button');
      btn.className  = 'dte-dialog-btn';
      if (idx === 0) btn.classList.add('dte-dialog-btn--cancel');
      if (idx === buttons.length - 1 && buttons.length > 1)
        btn.classList.add('dte-dialog-btn--primary');
      btn.textContent = label;
      btn.addEventListener('click', () => cleanup(value));
      els.dteDialogButtons.appendChild(btn);
    });

    // backdrop クリック → キャンセル
    const onDialogClick = e => {
      if (e.target === dialog) {
        dialog.removeEventListener('click', onDialogClick);
        cleanup('cancel');
      }
    };
    dialog.addEventListener('click', onDialogClick);

    // ESC → キャンセル
    dialog.addEventListener('cancel', e => {
      e.preventDefault();
      cleanup('cancel');
    }, { once: true });

    dialog.showModal();

    // showModal() 後にレイアウト済みサイズが確定するのでアンカー位置へ移動
    if (anchorEl) {
      const btnRect = anchorEl.getBoundingClientRect();
      const dlgRect = dialog.getBoundingClientRect();
      const gap     = 6;

      // ダイアログ下辺をボタン上辺の少し上に合わせる
      let top  = btnRect.top - dlgRect.height - gap;
      // ボタン中央を基準に水平配置
      let left = btnRect.left + btnRect.width / 2 - dlgRect.width / 2;

      // ビューポートからはみ出さないようクランプ
      const pad = 8;
      top  = Math.max(pad, Math.min(top,  window.innerHeight - dlgRect.height - pad));
      left = Math.max(pad, Math.min(left, window.innerWidth  - dlgRect.width  - pad));

      dialog.style.margin = '0';
      dialog.style.top    = `${top}px`;
      dialog.style.left   = `${left}px`;
    }
  });
}

/**
 * スクラッチパッドの before / after と挿入テキスト text から
 * junction に必要なコンマ区切りを計算する。
 * 実際の文字列は変更せず、比較にのみ trim を使う。
 *
 * before の末尾パターン:
 *   "tag, " → すでに `, ` あり → 追加不要
 *   "tag,"  → コンマのみ → スペースだけ追加
 *   "tag"   → 何もなし  → `, ` を追加
 * after の先頭パターン:
 *   ", tag" / ",tag" → コンマあり → 追加不要
 *   "tag"            → なし        → `, ` を追加
 */
function buildJunctionSeparators(before, after, text) {
  let sepBefore = '';
  if (before.length > 0 && !text.startsWith(',')) {
    const bTrimmed = before.trimEnd();
    if (bTrimmed.length === 0) {
      // before が空白のみ → 区切り不要
    } else if (bTrimmed.endsWith(',')) {
      // コンマが末尾にある: `, ` で終わっていればスペース不要、そうでなければ追加
      sepBefore = before.endsWith(', ') ? '' : ' ';
    } else {
      sepBefore = ', ';
    }
  }

  let sepAfter = '';
  if (after.length > 0 && !text.trimEnd().endsWith(',')) {
    const aTrimmed = after.trimStart();
    if (aTrimmed.length === 0) {
      // after が空白のみ → 区切り不要
    } else if (aTrimmed.startsWith(',')) {
      // after 側にコンマがある → 追加不要
    } else {
      sepAfter = ', ';
    }
  }

  return { sepBefore, sepAfter };
}

/** カーソルの行インデックスと列を返す */
function getCursorLC(input) {
  const pos    = input.selectionStart;
  const before = input.value.slice(0, pos);
  const lines  = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

/** 指定の行インデックス・列にカーソルを移動する（はみ出しは clamp） */
function setCursorLC(input, { line, col }) {
  const lines = input.value.split('\n');
  const l = Math.min(line, lines.length - 1);
  const c = Math.min(col,  lines[l].length);
  let pos = 0;
  for (let i = 0; i < l; i++) pos += lines[i].length + 1;
  pos += c;
  input.setSelectionRange(pos, pos);
}

/**
 * スクラッチパッドのカーソル位置に text を挿入する。
 * スクラッチパッドが空のときもこの関数を使う（separator が付かないだけ）。
 */
function insertAtScratchpadCursor(text) {
  const input = els.scratchpadInput;
  const pos    = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const after  = input.value.slice(pos);

  let { sepBefore, sepAfter } = buildJunctionSeparators(before, after, text);
  // 行頭（pos=0 またはカーソル直前が改行）では前置セパレータを付与しない
  if (pos === 0 || before.endsWith('\n')) sepBefore = '';
  input.value = before + sepBefore + text + sepAfter + after;

  // カーソルを挿入テキストの直後に移動
  const newPos = before.length + sepBefore.length + text.length + sepAfter.length;
  input.setSelectionRange(newPos, newPos);

  // 保存トリガー（input イベントと同じデバウンス処理）
  input.dispatchEvent(new Event('input'));
}

/** txt2img プロンプトをスクラッチパッドに読み込む */
async function readFromTxt2Img() {
  const target   = els.a1111PromptTarget.value;
  const textarea = findPromptTextarea(target);
  if (!textarea) {
    showToast('⚠️ プロンプト欄が見つかりません');
    return;
  }

  const readText = textarea.value;  // as-is: 改行・字下げを含めて変更しない
  if (!readText) {
    showToast('⚠️ プロンプトが空です');
    return;
  }

  const hasContent = els.scratchpadInput.value.length > 0;
  if (hasContent) {
    const choice = await showDteDialog({
      message: 'スクラッチパッドにテキストがあります',
      buttons: [
        { label: 'キャンセル',         value: 'cancel' },
        { label: 'カーソル位置に追加', value: 'insert' },
        { label: 'クリアして読み込む', value: 'clear'  },
      ],
      anchorEl: els.a1111ReadBtn,
    });
    if (choice === 'cancel') return;
    if (choice === 'clear') {
      els.scratchpadInput.value = '';
    }
    // 'insert' はそのままカーソル位置へ挿入
  }

  insertAtScratchpadCursor(readText);

  // 空行3行以上のブロックがあればカーソルをその2行目（先頭）に移動
  {
    const val = els.scratchpadInput.value;
    const idx = val.indexOf('\n\n\n');
    if (idx !== -1) {
      const targetPos = idx + 1;
      els.scratchpadInput.setSelectionRange(targetPos, targetPos);
    }
  }

  a1111SyncedContent = els.scratchpadInput.value;
  updateSendBtnDirty();
  showToast('✅ プロンプトを読み込みました');
}

/** スクラッチパッドの内容を txt2img プロンプトに送出する */
async function sendToTxt2Img() {
  const target   = els.a1111PromptTarget.value;
  const textarea = findPromptTextarea(target);
  if (!textarea) {
    showToast('⚠️ プロンプト欄が見つかりません');
    return;
  }

  if (!els.scratchpadInput.value.trim()) {
    showToast('⚠️ スクラッチパッドが空です');
    return;
  }

  if (textarea.value) {
    const choice = await showDteDialog({
      message: 'txt2img のプロンプトを上書きしますか？',
      buttons: [
        { label: 'キャンセル',  value: 'cancel'    },
        { label: '上書きする',  value: 'overwrite' },
      ],
      anchorEl: els.a1111SendBtn,
    });
    if (choice !== 'overwrite') return;
  }

  // Gradio の内部状態に反映させるため input イベントを発火する
  textarea.value = els.scratchpadInput.value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  a1111SyncedContent = els.scratchpadInput.value;
  updateSendBtnDirty();
  switchToA1111Tab('txt2img');
  showToast('✅ プロンプトを送出しました');
}

/**
 * スクラッチパッドの内容を整形する。
 *   - 全体の trim
 *   - コンマ正規化: \s*,+\s* → ", " （空行はスキップ）
 * Ctrl-Z で取り消せるよう execCommand('insertText') を使う。
 */
function applyFormat(value) {
  // (\s*,\s*)+ でスペースを挟んだ多重コンマも一括して ", " に置換する
  // 例: "a , , , b" → "a, b" / "a,,b" → "a, b"
  return value
    .split('\n')
    .map(line => line.trim() === '' ? line : line.replace(/(\s*,\s*)+/g, ', '))
    .join('\n')
    .trim();
}

function formatScratchpad() {
  const input     = els.scratchpadInput;
  const formatted = applyFormat(input.value);
  if (formatted === input.value) return;   // 変化なし → undo スタックを汚さない

  input.focus();
  input.select();
  // execCommand は deprecated だが textarea の undo スタックを保持する唯一の手段
  document.execCommand('insertText', false, formatted);
}

/** A1111 モード時に呼ばれる: UI を表示してイベントリスナーを登録する */
function initA1111Mode() {
  els.a1111Actions.classList.remove('hidden');
  els.a1111ReadBtn.addEventListener('click', readFromTxt2Img);
  els.a1111SendBtn.addEventListener('click', sendToTxt2Img);
  els.scratchpadInput.addEventListener('input', updateSendBtnDirty);
}

// Keyboard shortcut: / to focus search
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== els.globalSearch) {
    e.preventDefault();
    els.globalSearch.focus();
    els.globalSearch.select();
  }
});

// Mobile: tap outside wiki preview to close it
document.addEventListener('click', e => {
  if (isCoarsePointer() &&
      wikiPreviewEl.style.display === 'block' &&
      !wikiPreviewEl.contains(e.target) &&
      !e.target.closest('.tag-btn')) {
    hideWikiPreview();
  }
});

// ── Tag Detail Modal ──────────────────────────
function openTagDetail(tagName, breadcrumb) {
  const catColors = {
    0: 'var(--cat-0)', 1: 'var(--cat-1)', 3: 'var(--cat-3)',
    4: 'var(--cat-4)', 5: 'var(--cat-5)'
  };
  const meta  = state.tagMeta.get(tagName);
  const color = catColors[meta?.category] ?? 'var(--cat-x)';
  const jaName = state.translations?.get(tagName) ?? '';

  // ── 基本情報 ──
  els.detailTagName.textContent  = tagName;
  els.detailTagName.style.color  = color;
  els.detailTagName.title        = 'クリックでカードに移動';
  els.detailTagName.style.cursor = 'pointer';
  els.detailTagName.onclick = () => {
    const bc = state.tagNodes.get(tagName)?.breadcrumb ?? [];
    closeTagDetail();
    if (bc.length > 0) {
      navigateTo(bc);
      // カードが描画されたあとスクロール＆ハイライト
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const card = els.tagsGrid.querySelector(`[data-tag-name="${CSS.escape(tagName)}"]`);
        if (card) {
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card.classList.add('highlight');
          setTimeout(() => card.classList.remove('highlight'), 1800);
        }
      }));
    } else {
      // カテゴリ未登録：検索結果に移動
      navigateTo(['__search_result__', tagName]);
    }
  };
  els.detailTagJa.textContent    = jaName;
  els.detailTagJa.style.display  = jaName ? '' : 'none';

  // Post count
  const count = meta?.count ?? 0;
  els.detailPostCount.textContent = count > 0 ? count.toLocaleString() + ' posts' : '';

  // Breadcrumb (clickable)
  els.detailBreadcrumb.innerHTML = '';
  const bc = breadcrumb ?? state.tagNodes.get(tagName)?.breadcrumb ?? [];
  if (bc.length > 0) {
    bc.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'detail-bc-sep';
        sep.textContent = ' › ';
        els.detailBreadcrumb.appendChild(sep);
      }
      const span = document.createElement('span');
      span.className = 'detail-bc-link';
      span.textContent = translateCategory(seg);
      span.addEventListener('click', () => {
        closeTagDetail();
        els.searchOverlay.classList.add('hidden');
        navigateTo(bc.slice(0, i + 1));
      });
      els.detailBreadcrumb.appendChild(span);
    });
  } else {
    const span = document.createElement('span');
    span.className = 'detail-bc-none';
    span.textContent = '（カテゴリ未登録）';
    els.detailBreadcrumb.appendChild(span);
  }

  // Wiki body (async) — 全文表示・タグリンク付き
  els.detailWikiBody.innerHTML = '<span class="detail-wiki-loading">…</span>';
  fetchTagWikiInfo(tagName).then(info => {
    els.detailWikiBody.innerHTML = '';
    if (!info || (!info.otherNames.length && !info.rawBody)) {
      els.detailWikiBody.textContent = '（Wiki 情報なし）';
      return;
    }
    if (info.otherNames.length > 0) {
      const aliasEl = document.createElement('div');
      aliasEl.className = 'detail-wiki-aliases';
      const aliasLabel = document.createElement('span');
      aliasLabel.className = 'detail-wiki-alias-label';
      aliasLabel.textContent = 'Aliases: ';
      aliasEl.appendChild(aliasLabel);
      info.otherNames.forEach((name, i) => {
        if (i > 0) aliasEl.appendChild(document.createTextNode(' / '));
        const span = document.createElement('span');
        span.className = 'detail-wiki-taglink';
        span.textContent = name;
        span.title = name;
        span.addEventListener('click', () => openTagDetail(name.replace(/ /g, '_'), state.tagNodes.get(name.replace(/ /g, '_'))?.breadcrumb));
        aliasEl.appendChild(span);
      });
      els.detailWikiBody.appendChild(aliasEl);
    }
    if (info.rawBody) {
      renderWikiBody(info.rawBody, els.detailWikiBody);
    }
    if (!info.otherNames.length && !info.rawBody) {
      els.detailWikiBody.textContent = '（Wiki 情報なし）';
    }
  });

  // ── お気に入りボタン ──
  _updateDetailFavBtn(tagName);

  // ── フッターボタン ──
  els.detailWikiBtn.onclick = () => {
    const tagNode = state.tagNodes.get(tagName);
    const tagUrl  = tagNode?.url || `/wiki_pages/${tagName}`;
    const url = tagUrl.startsWith('http') ? tagUrl : `https://danbooru.donmai.us${tagUrl}`;
    window.open(url, '_blank', 'noopener');
  };
  els.detailFavBtn.onclick = () => {
    if (state.favTags.has(tagName)) {
      state.favTags.delete(tagName);
      showToast('♡ お気に入りから削除しました');
    } else {
      state.favTags.add(tagName);
      showToast('♥ お気に入りに追加しました');
    }
    saveFavs();
    renderFavTree();
    rerenderCurrent();
    _updateDetailFavBtn(tagName);
  };
  els.detailCopyBtn.onclick = () => {
    copyToClipboard(formatTagForExport(tagName, { withComma: true }));
  };

  // ── 表示 ──
  els.tagDetailOverlay.classList.remove('hidden');
  document.body.classList.add('dte-no-select');
}

function _updateDetailFavBtn(tagName) {
  const isFav = state.favTags.has(tagName);
  els.detailFavBtn.textContent = isFav ? '♥ お気に入り解除' : '♡ お気に入り';
  els.detailFavBtn.classList.toggle('active', isFav);
}

function closeTagDetail() {
  els.tagDetailOverlay.classList.add('hidden');
  document.body.classList.remove('dte-no-select');
}

// モーダル外クリックで閉じる
els.tagDetailOverlay.addEventListener('click', e => {
  if (e.target === els.tagDetailOverlay) closeTagDetail();
});
els.detailCloseBtn.addEventListener('click', closeTagDetail);

// ── Wiki Preview Tooltip ──────────────────────────
const wikiPreviewEl = (() => {
  const el = document.createElement('div');
  el.className = 'wiki-preview';
  document.body.appendChild(el);
  return el;
})();

const _wikiInfoCache = new Map();

// ── Wiki DText レンダラー（モーダル用・タグリンク付き）────
function renderWikiBody(text, container) {
  // 基本的なフォーマットタグを除去しつつ [[tag]] / {{tag}} は保持
  let processed = text
    .replace(/\[(?:b|i|s|u|tn)\](.*?)\[\/(?:b|i|s|u|tn)\]/gs, '$1')
    .replace(/\[spoiler\](.*?)\[\/spoiler\]/gs, '[$1]')
    .replace(/\[url=[^\]]+\](.*?)\[\/url\]/gs, '$1')
    .replace(/\[(?:table|thead|tbody|tr|th|td)[^\]]*\](.*?)\[\/(?:table|thead|tbody|tr|th|td)\]/gs, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = processed.split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      container.appendChild(document.createElement('br'));
      continue;
    }
    const headerMatch = line.match(/^h([1-6])\.\s*(.*)/);
    if (headerMatch) {
      const el = document.createElement('div');
      el.className = 'detail-wiki-heading detail-wiki-h' + headerMatch[1];
      appendWikiInline(headerMatch[2], el);
      container.appendChild(el);
      continue;
    }
    const listMatch = line.match(/^(\*+)\s*(.*)/);
    if (listMatch) {
      const el = document.createElement('div');
      el.className = 'detail-wiki-listitem';
      el.style.paddingLeft = (listMatch[1].length * 14) + 'px';
      el.appendChild(document.createTextNode('• '));
      appendWikiInline(listMatch[2], el);
      container.appendChild(el);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'detail-wiki-line';
    appendWikiInline(line, el);
    container.appendChild(el);
  }
}

function appendWikiInline(text, container) {
  // [[tag_name]] [[tag_name|display]] {{tag_name}} をクリッカブルに
  const pat = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\{\{([^}|]+)(?:\|[^}]*)?\}\}/g;
  let last = 0, m;
  while ((m = pat.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const rawTag   = (m[1] ?? m[3]).trim();
    const tagName  = rawTag.replace(/ /g, '_').toLowerCase();
    const display  = (m[2] ?? m[1] ?? m[3]).trim();
    const span = document.createElement('span');
    span.className = 'detail-wiki-taglink';
    span.textContent = display;
    span.title = tagName;
    span.addEventListener('click', () =>
      openTagDetail(tagName, state.tagNodes.get(tagName)?.breadcrumb));
    container.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

async function fetchTagWikiInfo(tagName) {
  if (_wikiInfoCache.has(tagName)) {
    const cached = _wikiInfoCache.get(tagName);
    // rawBody がないキャッシュ（旧フォーマット）はスキップして再取得
    if (cached === null || cached.rawBody !== undefined) return cached;
  }
  try {
    const res = await fetch(
      `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tagName)}.json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const info = {
      otherNames: Array.isArray(data.other_names) ? data.other_names : [],
      body: dTextToPlain(data.body || ''),
      rawBody: data.body || '',
    };
    _wikiInfoCache.set(tagName, info);
    return info;
  } catch {
    _wikiInfoCache.set(tagName, null);
    return null;
  }
}

function dTextToPlain(text) {
  return text
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\{\{([^|}]+)(?:\|[^}]*)?\}\}/g, '$1')
    .replace(/\[(?:b|i|s|u|tn|spoiler)\](.*?)\[\/(?:b|i|s|u|tn|spoiler)\]/gs, '$1')
    .replace(/\[url=[^\]]+\](.*?)\[\/url\]/gs, '$1')
    .replace(/\[(?:table|thead|tbody|tr|th|td)[^\]]*\](.*?)\[\/(?:table|thead|tbody|tr|th|td)\]/gs, '$1')
    .replace(/h[1-6]\.\s*/g, '')
    .replace(/^\*+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns true when the primary pointer is coarse (touch screen)
function isCoarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches;
}

function openWikiLink(tag) {
  const tagUrl = tag.url || `/wiki_pages/${tag.name}`;
  const url = tagUrl.startsWith('http') ? tagUrl : `https://danbooru.donmai.us${tagUrl}`;
  window.open(url, '_blank');
}

function showWikiPreview(e, tag, meta, opts = {}) {
  wikiPreviewEl._anchorLeft = opts.anchorLeft || false;
  wikiPreviewEl._fixedPos   = opts.fixedPos   || null;
  const catColors = {
    0: 'var(--cat-0)', 1: 'var(--cat-1)', 3: 'var(--cat-3)',
    4: 'var(--cat-4)', 5: 'var(--cat-5)'
  };
  const color = catColors[meta?.category] ?? 'var(--cat-x)';
  const mobile = isCoarsePointer();

  // Build initial content with DOM nodes (so mobile hint stays last)
  wikiPreviewEl.innerHTML = '';

  const nameEl = document.createElement('div');
  nameEl.className = 'wiki-preview-name';
  nameEl.style.color = color;
  nameEl.textContent = tag.name;
  wikiPreviewEl.appendChild(nameEl);

  const loadingEl = document.createElement('div');
  loadingEl.className = 'wiki-preview-loading';
  loadingEl.textContent = '…';
  wikiPreviewEl.appendChild(loadingEl);

  // Mobile hint: shown at bottom, persists after async content loads
  if (mobile) {
    const hintEl = document.createElement('div');
    hintEl.className = 'wiki-preview-mobile-hint';
    hintEl.textContent = '↗ 再タップで移動 ';
    wikiPreviewEl.appendChild(hintEl);
  }

  if (opts.fixedPos) {
    wikiPreviewEl.style.left  = opts.fixedPos.x + 'px';
    wikiPreviewEl.style.top   = opts.fixedPos.y + 'px';
    wikiPreviewEl.style.width = '';
  } else {
    repositionWikiPreview(e);
  }
  wikiPreviewEl.style.display = 'block';

  fetchTagWikiInfo(tag.name).then(info => {
    if (wikiPreviewEl.style.display !== 'block') return;
    const loading = wikiPreviewEl.querySelector('.wiki-preview-loading');
    if (loading) loading.remove();
    if (!info) return;

    // Insert content BEFORE the mobile hint so it stays at the bottom
    const hint = wikiPreviewEl.querySelector('.wiki-preview-mobile-hint');

    if (info.otherNames.length > 0) {
      const el = document.createElement('div');
      el.className = 'wiki-preview-aliases';
      el.textContent = info.otherNames.slice(0, 8).join(' / ');
      hint ? wikiPreviewEl.insertBefore(el, hint) : wikiPreviewEl.appendChild(el);
    }

    if (info.body) {
      let body = info.body;
      if (body.length > 240) {
        const cut = body.lastIndexOf('.', 240);
        body = cut > 60 ? body.slice(0, cut + 1) : body.slice(0, 240) + '…';
      }
      const el = document.createElement('div');
      el.className = 'wiki-preview-body';
      el.textContent = body;
      hint ? wikiPreviewEl.insertBefore(el, hint) : wikiPreviewEl.appendChild(el);
    }
  });
}

function repositionWikiPreview(e) {
  if (wikiPreviewEl._fixedPos) return;
  if (isCoarsePointer()) {
    // Mobile: center horizontally, fixed near top
    const w = Math.min(300, window.innerWidth - 32);
    wikiPreviewEl.style.width = w + 'px';
    wikiPreviewEl.style.left = ((window.innerWidth - w) / 2) + 'px';
    wikiPreviewEl.style.top  = '72px'; // just below header
  } else {
    const anchorLeft = wikiPreviewEl._anchorLeft;
    const x = anchorLeft
      ? Math.max(8, e.clientX - 340 - 14)
      : Math.min(e.clientX + 14, window.innerWidth - 340);
    const y = Math.min(e.clientY + 14, window.innerHeight - 260);
    wikiPreviewEl.style.left = x + 'px';
    wikiPreviewEl.style.top  = y + 'px';
    wikiPreviewEl.style.width = '';
  }
}

function hideWikiPreview() {
  wikiPreviewEl.style.display = 'none';
  wikiPreviewEl._activeTag = null;
}

// ── Highlight CSS ────────────────────────────────────
const highlightStyle = document.createElement('style');
highlightStyle.textContent = `
  .tag-card.highlight {
    border-color: var(--accent) !important;
    box-shadow: 0 0 0 3px var(--accent-glow) !important;
  }
  .search-result-count {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-dim);
    margin-left: auto;
    flex-shrink: 0;
  }
`;
document.head.appendChild(highlightStyle);

// Init
initResizer();
initMobileSidebar();
initSettingsModal();
initScratchpadTabs();
initLlmConvert();
initScratchpadToggle();
initScratchpadResizer();
boot();
