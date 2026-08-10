// カナつなぎパズル — 先に「答え」の盤面を生成してから穴埋め問題として出題する
// 依存なし。names.js / hints.js / generator.js を使う。
//
// ルール: 10個の名前(回答)でできた盤面を3分いないに完成させる。
// 名前成立から10秒いないに次を成立させると連鎖(正解表示中は猶予停止)。

const MAX_CELLS = 70;
const WORD_COUNT = 10;   // 回答(名前)の数は固定
const GIVEN_RATIO = 0.22; // はじめから見えている文字の割合
const TIME_LIMIT = 180;  // 制限時間(秒)
const CHAIN_WINDOW = 20; // 連鎖の猶予(秒)

// 世代ごとの図鑑番号の上限（「第n世代まで」の累積フィルタに使う）
const GEN_MAX = [151, 251, 386, 493, 649, 721, 809, 905, 1025];

let activeNames, nameSet, nameToId;

function setGeneration(gen) {
  const maxId = GEN_MAX[gen - 1];
  activeNames = POKEMON_NAMES.filter(([id]) => id <= maxId);
  nameSet = new Set(activeNames.map(e => e[1]));
  nameToId = new Map();
  for (const [id, name] of activeNames) {
    if (!nameToId.has(name)) nameToId.set(name, id);
  }
}

// --- 状態 ---
let puzzle;          // generatePuzzle の結果
let answer;          // "r,c" -> 正解の文字
let givenKeys;       // 最初から見えているマス
let board;           // "r,c" -> いま置かれている文字(given含む)
let palette;         // 文字 -> のこり枚数(盤面に置かれていないぶん。セット中も含む)
let runsAt;          // "r,c" -> そのマスを含む run 番号の配列
let queue;           // 回答セット: 置く順番に並んだ文字の列(先頭から置かれる)
let selectedTile;    // 入れ替え用に選択中の文字の位置 | null
let startKey;        // 区間置きの開始マス(選択中のみ)
let scoredRuns, score, foundLog, finished;
let timeLeft;        // のこり時間(秒)
let chainCount;      // いまの連鎖数(0 = 連鎖なし)
let chainRemaining;  // 次の連鎖までの猶予(秒)
let maxChainSeen;
let popupVisible;    // 正解モーダル表示中(連鎖猶予を止める)

const boardEl = document.getElementById('board');
const paletteEl = document.getElementById('palette');
const slotsEl = document.getElementById('slots');
const scoreEl = document.getElementById('score');
const timerEl = document.getElementById('timer');
const doneEl = document.getElementById('words-done');
const chainInfoEl = document.getElementById('chain-info');
const logEl = document.getElementById('log');
const toastEl = document.getElementById('toast');

let cellEls; // "r,c" -> 要素

function init() {
  puzzle = generatePuzzle(activeNames, MAX_CELLS, WORD_COUNT);
  answer = new Map(puzzle.cells.map(cl => [cl.r + ',' + cl.c, cl.ch]));

  runsAt = new Map();
  puzzle.runs.forEach((run, i) => {
    for (const [r, c] of run.cells) {
      const key = r + ',' + c;
      if (!runsAt.has(key)) runsAt.set(key, []);
      runsAt.get(key).push(i);
    }
  });

  // ヒントとしてランダムに公開する。ただし回答数を保つため、
  // どの並びにも最低1マスはあきを残す
  givenKeys = new Set();
  const target = Math.ceil(puzzle.cellCount * GIVEN_RATIO);
  const cand = puzzle.cells.map(cl => cl.r + ',' + cl.c);
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  for (const key of cand) {
    if (givenKeys.size >= target) break;
    const ok = (runsAt.get(key) || []).every(i =>
      puzzle.runs[i].cells.some(([r, c]) => {
        const k = r + ',' + c;
        return k !== key && !givenKeys.has(k);
      }));
    if (ok) givenKeys.add(key);
  }

  board = new Map();
  for (const k of givenKeys) board.set(k, answer.get(k));

  palette = new Map();
  for (const [k, ch] of answer) {
    if (!givenKeys.has(k)) palette.set(ch, (palette.get(ch) || 0) + 1);
  }

  queue = [];
  selectedTile = null;
  startKey = null;
  scoredRuns = new Set();
  score = 0;
  foundLog = [];
  finished = false;
  timeLeft = TIME_LIMIT;
  chainCount = 0;
  chainRemaining = 0;
  maxChainSeen = 0;
  popupVisible = false;
  logEl.innerHTML = '';
  hideWordPopup();

  buildBoard();
  renderAll();
}

// --- 盤面 DOM 構築(問題ごとに形が変わる) ---
function buildBoard() {
  boardEl.innerHTML = '';
  boardEl.style.gridTemplateColumns = `repeat(${puzzle.cols}, 1fr)`;
  boardEl.style.width = `min(92vw, ${puzzle.cols * 44 + 22}px)`;
  cellEls = new Map();
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const el = document.createElement('div');
      const key = r + ',' + c;
      if (answer.has(key)) {
        el.className = 'cell';
        el.addEventListener('click', () => onCellClick(key));
        cellEls.set(key, el);
      } else {
        el.className = 'cell void';
      }
      boardEl.appendChild(el);
    }
  }
}

// --- run の状態 ---
function runString(i) {
  let s = '';
  for (const [r, c] of puzzle.runs[i].cells) {
    const ch = board.get(r + ',' + c);
    if (!ch) return null; // 未完成
    s += ch;
  }
  return s;
}

function invalidKeys() {
  const bad = new Set();
  puzzle.runs.forEach((run, i) => {
    const s = runString(i);
    if (s !== null && !nameSet.has(s)) {
      for (const [r, c] of run.cells) bad.add(r + ',' + c);
    }
  });
  return bad;
}

// --- 回答セット ---
// パレットの枚数から、セットに入れたぶんを引いたのこり
function remaining(ch) {
  let used = 0;
  for (const q of queue) if (q === ch) used++;
  return (palette.get(ch) || 0) - used;
}

// セット内の文字クリック: 選択 → もう1回で外す / べつの文字クリックで入れ替え
function onTileClick(i) {
  if (finished) return;
  if (selectedTile === null) {
    selectedTile = i;
    renderAll();
    return;
  }
  if (selectedTile === i) {
    // 同じ文字をもう一度クリック → パレットに戻す
    queue.splice(i, 1);
    selectedTile = null;
    renderAll();
    return;
  }
  // 文字の入れ替え
  [queue[selectedTile], queue[i]] = [queue[i], queue[selectedTile]];
  selectedTile = null;
  renderAll();
}

// セットの空き部分クリック: 選択中の文字を末尾へ移す
function onSlotClick() {
  if (finished || selectedTile === null) return;
  const ch = queue.splice(selectedTile, 1)[0];
  queue.push(ch);
  selectedTile = null;
  renderAll();
}

// --- ヒント ---
// hints.js のエントリから説明テキストを作る
function hintText(id) {
  const hint = POKEMON_HINTS[id];
  if (!hint) return null;
  const [text, , kind] = hint;
  return kind === 0 ? `「${text}」`
    : kind === 1 ? `ぶんるい：${text}`
    : `タイプ：${text}`;
}

function showHintFor(key) {
  const body = document.getElementById('hint-body');
  body.innerHTML = '';
  for (const i of runsAt.get(key) || []) {
    const run = puzzle.runs[i];
    const name = run.cells.map(([r, c]) => answer.get(r + ',' + c)).join('');
    const div = document.createElement('div');
    div.className = 'hint-run';
    div.innerHTML = `<h3>${run.dir === 'H' ? 'ヨコ' : 'タテ'} ${name.length}文字</h3>`
      + `<p class="hint-text">${hintText(nameToId.get(name)) || 'ヒントなし'}</p>`;
    body.appendChild(div);
  }
  document.getElementById('hint-modal').classList.remove('hidden');
}

// --- 名前成立ポップアップ ---
const SPRITES_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

// 汎用ボール型のプレースホルダ(データURI・外部依存なし)
const PLACEHOLDER_URI = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + '<circle cx="50" cy="50" r="40" fill="#fdf6e3" stroke="#3a3226" stroke-width="5"/>'
  + '<path d="M10 50h80" stroke="#3a3226" stroke-width="5"/>'
  + '<circle cx="50" cy="50" r="12" fill="#fdf6e3" stroke="#3a3226" stroke-width="5"/>'
  + '</svg>');

// 公式アートワーク → 通常スプライト → プレースホルダ の3段フォールバック
function attachFallback(img, id) {
  let stage = 0;
  img.onerror = () => {
    stage++;
    if (stage === 1) img.src = `${SPRITES_BASE}/${id}.png`;
    else { img.onerror = null; img.src = PLACEHOLDER_URI; }
  };
  img.src = `${SPRITES_BASE}/other/official-artwork/${id}.png`;
}

let popupTimer = null;
function showWordPopup(words, chain) {
  const box = document.getElementById('word-popup-box');
  box.innerHTML = '';
  if (chain >= 2) {
    const badge = document.createElement('div');
    badge.className = 'chain-badge';
    badge.textContent = `${chain}連鎖！`;
    box.appendChild(badge);
  }
  for (const w of words) {
    const id = nameToId.get(w.name);
    const entry = document.createElement('div');
    entry.className = 'word-entry';
    const img = document.createElement('img');
    img.alt = w.name;
    attachFallback(img, id);
    const label = document.createElement('div');
    label.className = 'word-label';
    label.innerHTML = `<span class="no">No.${String(id).padStart(4, '0')}</span>${w.name}`;
    entry.appendChild(img);
    entry.appendChild(label);
    const flavor = hintText(id);
    if (flavor) {
      const p = document.createElement('p');
      p.className = 'word-flavor';
      p.textContent = flavor;
      entry.appendChild(p);
    }
    box.appendChild(entry);
  }
  popupVisible = true; // 表示中は連鎖猶予のカウント停止
  document.getElementById('word-popup').classList.remove('hidden');
  clearTimeout(popupTimer);
  popupTimer = setTimeout(hideWordPopup, 5000);
}

function hideWordPopup() {
  clearTimeout(popupTimer);
  popupVisible = false;
  document.getElementById('word-popup').classList.add('hidden');
}

// --- 描画 ---
function renderAll() {
  const bad = invalidKeys();
  const placing = !finished && queue.length > 0;
  for (const [key, el] of cellEls) {
    const ch = board.get(key);
    el.textContent = ch || '';
    el.className = 'cell';
    if (ch) {
      el.classList.add('filled');
      if (givenKeys.has(key)) el.classList.add('given');
      if (bad.has(key)) el.classList.add('invalid');
      // 開始マスと同じ並びなら「終わり」に指定できる印
      if (placing && startKey && key !== startKey && segmentBetween(startKey, key)) el.classList.add('aligned');
    } else if (placing) {
      if (key === startKey) el.classList.add('start');
      else if (startKey && segmentBetween(startKey, key)) el.classList.add('aligned');
      else el.classList.add('placeable');
    }
  }

  // 回答セット(1つ)
  slotsEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'slot' + (queue.length > 0 ? ' active' : ' empty-slot');
  queue.forEach((ch, i) => {
    const t = document.createElement('div');
    t.className = 'queue-tile'
      + (i === 0 ? ' next' : '')
      + (selectedTile === i ? ' picked' : '');
    t.textContent = ch;
    t.addEventListener('click', (e) => { e.stopPropagation(); onTileClick(i); });
    div.appendChild(t);
  });
  if (queue.length === 0) {
    const ph = document.createElement('span');
    ph.className = 'slot-ph';
    ph.textContent = 'パレットから文字をセット';
    div.appendChild(ph);
  }
  div.addEventListener('click', onSlotClick);
  slotsEl.appendChild(div);

  paletteEl.innerHTML = '';
  const chars = [...palette.keys()].filter(ch => palette.get(ch) > 0).sort();
  for (const ch of chars) {
    const rem = remaining(ch);
    const chip = document.createElement('div');
    chip.className = 'chip' + (rem <= 0 ? ' depleted' : '');
    chip.innerHTML = `${ch}<span class="cnt">${rem}</span>`;
    chip.addEventListener('click', () => {
      if (finished || remaining(ch) <= 0) return;
      queue.push(ch);
      renderAll();
    });
    paletteEl.appendChild(chip);
  }

  scoreEl.textContent = score;
  doneEl.textContent = scoredRuns.size + '/' + WORD_COUNT;
  updateTimerDisplay();
  updateChainDisplay();
}

function updateTimerDisplay() {
  const t = Math.max(0, Math.ceil(timeLeft));
  const m = Math.floor(t / 60);
  const s = String(t % 60).padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
  timerEl.classList.toggle('warn', timeLeft <= 30 && !finished);
}

function updateChainDisplay() {
  if (finished || chainCount === 0) {
    chainInfoEl.classList.add('hidden');
    return;
  }
  chainInfoEl.classList.remove('hidden');
  chainInfoEl.textContent =
    `あと${Math.max(0, chainRemaining).toFixed(1)}秒で${chainCount + 1}連鎖`
    + (popupVisible ? '（停止中）' : '');
}

let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// --- 操作 ---
// a と b が同じ並び(run)の上にあれば、a→b の順のマス列を返す。なければ null
function segmentBetween(a, b) {
  for (const i of runsAt.get(a) || []) {
    const cells = puzzle.runs[i].cells.map(([r, c]) => r + ',' + c);
    const ia = cells.indexOf(a), ib = cells.indexOf(b);
    if (ia !== -1 && ib !== -1) {
      const seg = cells.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
      return ia <= ib ? seg : seg.reverse();
    }
  }
  return null;
}

// 1マス置いて、新しく完成した並びを返す
function placeAt(key, ch) {
  board.set(key, ch);
  palette.set(ch, palette.get(ch) - 1);
  const completed = [];
  for (const i of runsAt.get(key) || []) {
    if (scoredRuns.has(i)) continue;
    const s = runString(i);
    if (s !== null && nameSet.has(s)) {
      scoredRuns.add(i);
      completed.push({ i, name: s });
    }
  }
  return completed;
}

// マス列に沿って回答セットの文字を順に置く(埋まっているマスは飛ばす)
function doPlacements(keys) {
  startKey = null;
  const placedKeys = [];
  const words = [];
  for (const key of keys) {
    if (queue.length === 0) break;
    if (board.has(key)) continue;
    words.push(...placeAt(key, queue.shift()));
    placedKeys.push(key);
  }
  selectedTile = null;
  if (placedKeys.length === 0) { renderAll(); return; }

  if (words.length > 0) {
    // 10秒いないの回答は連鎖。1回でまとめて成立したぶんも連鎖として数える
    for (const w of words) {
      chainCount++;
      maxChainSeen = Math.max(maxChainSeen, chainCount);
      score += w.name.length * 10 * chainCount;
      foundLog.push(w.name);
      const li = document.createElement('li');
      li.innerHTML = `<span class="no">No.${String(nameToId.get(w.name)).padStart(4, '0')}</span>${w.name}`;
      logEl.prepend(li);
    }
    chainRemaining = CHAIN_WINDOW;
    showWordPopup(words, chainCount);
  }

  renderAll();
  for (const key of placedKeys) cellEls.get(key).classList.add('just-placed');
  for (const w of words) {
    for (const [r, c] of puzzle.runs[w.i].cells) {
      cellEls.get(r + ',' + c).classList.add('flash');
    }
  }

  checkClear();
}

function onCellClick(key) {
  if (finished) return;

  if (board.has(key)) {
    // 開始マス選択中なら、同じ並びの埋まったマスも「終わり」として指定できる
    if (startKey && queue.length > 0) {
      const seg = segmentBetween(startKey, key);
      if (seg) { doPlacements(seg); return; }
    }
    startKey = null;
    if (givenKeys.has(key)) { renderAll(); return; }
    // 自分で置いた文字は取り外してパレットに戻せる
    const ch = board.get(key);
    board.delete(key);
    palette.set(ch, (palette.get(ch) || 0) + 1);
    renderAll();
    return;
  }

  // なにもセットしていないときは、あきマスのタップでヒントを表示
  if (queue.length === 0) { showHintFor(key); return; }

  // 1文字だけのときはワンクリックで置く
  if (queue.length === 1 && !startKey) { doPlacements([key]); return; }

  if (!startKey) {
    startKey = key; // 開始マスを選択
    renderAll();
    return;
  }

  if (startKey === key) { doPlacements([key]); return; } // 同じマスを2回 = そこに1文字だけ置く

  const seg = segmentBetween(startKey, key);
  if (seg) doPlacements(seg);
  else { startKey = key; renderAll(); } // つながっていないマス → 開始マスを選びなおし
}

// --- 終了処理 ---
function formatTime(sec) {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}分${t % 60}秒`;
}

function showResult(title, detail) {
  hideWordPopup();
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-score').textContent = score;
  document.getElementById('result-detail').textContent = detail;
  document.getElementById('result-modal').classList.remove('hidden');
}

function checkClear() {
  if (board.size !== puzzle.cellCount) return;
  for (let i = 0; i < puzzle.runs.length; i++) {
    if (!nameSet.has(runString(i))) return; // 赤いマスが残っている
  }
  finished = true;
  score += 100; // クリアボーナス
  renderAll();
  setTimeout(() => {
    showResult('パズルかんせい！',
      `10この名前をぜんぶ完成！\nのこりじかん ${formatTime(timeLeft)}\nさいだい ${maxChainSeen}連鎖`);
  }, 2800);
}

// 答えを盤面に表示し、答えられなかったマスを強調する
function revealAnswer() {
  const missing = [...answer.keys()].filter(k => !board.has(k));
  for (const k of missing) board.set(k, answer.get(k));
  palette = new Map();
  queue = [];
  selectedTile = null;
  startKey = null;
  renderAll();
  // renderAll が className を張り直すので、あらためて印をつける
  for (const k of missing) cellEls.get(k).classList.add('missed');
}

function timeUp() {
  finished = true;
  hideWordPopup();
  revealAnswer();
  showResult('じかんぎれ…',
    `かんせい ${scoredRuns.size}/${WORD_COUNT}語　さいだい ${maxChainSeen}連鎖\n答えられなかったところは赤く表示しています。\n「盤面を見る」で答えを確認できます。`);
}

// 制限時間と連鎖猶予のタイマー(0.1秒きざみ)
setInterval(() => {
  if (finished) return;
  timeLeft -= 0.1;
  updateTimerDisplay();
  if (timeLeft <= 0) { timeUp(); return; }
  if (chainCount > 0 && !popupVisible) {
    chainRemaining -= 0.1;
    if (chainRemaining <= 0) {
      chainCount = 0;
      chainRemaining = 0;
    }
  }
  updateChainDisplay();
}, 100);

// --- ボタン類 ---
document.getElementById('giveup-btn').addEventListener('click', () => {
  if (finished) return;
  finished = true;
  hideWordPopup();
  revealAnswer();
  showToast('こたえを表示しました');
});

document.getElementById('queue-clear-btn').addEventListener('click', () => {
  queue = [];
  selectedTile = null;
  startKey = null;
  renderAll();
});

document.getElementById('new-btn').addEventListener('click', init);
// 新しい問題は「つぎの問題へ」を押したときにだけ生成する
document.getElementById('result-restart-btn').addEventListener('click', () => {
  document.getElementById('result-modal').classList.add('hidden');
  init();
});
// モーダルをとじて盤面(答え)を確認できる
document.getElementById('result-close-btn').addEventListener('click', () => {
  document.getElementById('result-modal').classList.add('hidden');
});

const genSelect = document.getElementById('gen-select');
for (let g = 1; g <= GEN_MAX.length; g++) {
  const opt = document.createElement('option');
  opt.value = g;
  opt.textContent = g === GEN_MAX.length
    ? `ぜんぶ（〜No.${GEN_MAX[g - 1]}）`
    : `第${g}世代まで（〜No.${GEN_MAX[g - 1]}）`;
  genSelect.appendChild(opt);
}

const savedGen = parseInt(localStorage.getItem('kanatsunagi-gen'), 10);
const initialGen = (savedGen >= 1 && savedGen <= GEN_MAX.length) ? savedGen : GEN_MAX.length;
genSelect.value = initialGen;

genSelect.addEventListener('change', () => {
  const gen = parseInt(genSelect.value, 10);
  localStorage.setItem('kanatsunagi-gen', gen);
  setGeneration(gen);
  init(); // 辞書が変わるので新しい問題を出題
});

document.getElementById('help-btn').addEventListener('click', () => {
  document.getElementById('help-modal').classList.remove('hidden');
});
document.querySelector('#help-modal .close-btn').addEventListener('click', () => {
  document.getElementById('help-modal').classList.add('hidden');
});
document.querySelector('#hint-modal .close-btn').addEventListener('click', () => {
  document.getElementById('hint-modal').classList.add('hidden');
});
document.getElementById('word-popup').addEventListener('click', hideWordPopup);

setGeneration(initialGen);
init();
