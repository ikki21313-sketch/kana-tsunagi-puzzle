// クロスワード型の「答え」盤面ジェネレータ（DOM非依存・node でもテスト可能）
//
// generatePuzzle(names, maxCells, maxWords) -> {
//   rows, cols,                    // 盤面の大きさ(外接矩形)
//   cells: [{r, c, ch}],           // 答えの全マス
//   words: [{name, r, c, dir}],    // 配置した名前(dir: 'H' | 'V')
//   runs:  [{dir, cells: [[r,c]...]}], // タテヨコの極大な並び(=全て名前になっている)
//   cellCount,
// }

const GEN_CANVAS = 23;

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _getCell(grid, r, c) {
  if (r < 0 || c < 0 || r >= GEN_CANVAS || c >= GEN_CANVAS) return null;
  return grid[r][c];
}

// 置けるなら新規マス数、置けないなら -1
// 条件: 既存の文字とは交差(同一文字)のみ、新規マスの直交方向のとなりはあき、単語の前後はあき
function _canPlace(grid, word, r0, c0, dir) {
  const dr = dir === 'V' ? 1 : 0, dc = dir === 'H' ? 1 : 0;
  const endR = r0 + dr * (word.length - 1), endC = c0 + dc * (word.length - 1);
  if (r0 < 0 || c0 < 0 || endR >= GEN_CANVAS || endC >= GEN_CANVAS) return -1;
  if (_getCell(grid, r0 - dr, c0 - dc) || _getCell(grid, endR + dr, endC + dc)) return -1;
  let newCells = 0, crossings = 0, prevFilled = false;
  for (let i = 0; i < word.length; i++) {
    const r = r0 + dr * i, c = c0 + dc * i;
    const cur = grid[r][c];
    if (cur) {
      if (cur !== word[i]) return -1;
      // 連続2マスが既に埋まっている = 既存の語に沿った重ね置き(語の延長)なので禁止。
      // これで「置いた語」と「盤面の並び」が必ず1対1になる
      if (prevFilled) return -1;
      crossings++;
      prevFilled = true;
    } else {
      if (_getCell(grid, r + dc, c + dr) || _getCell(grid, r - dc, c - dr)) return -1;
      newCells++;
      prevFilled = false;
    }
  }
  if (crossings === 0 || newCells === 0) return -1;
  return newCells;
}

function _tryGenerate(names, maxCells, maxWords) {
  // 文字 → その文字を含む名前 の索引
  const charIndex = new Map();
  for (const [, name] of names) {
    for (const ch of new Set(name)) {
      if (!charIndex.has(ch)) charIndex.set(ch, []);
      charIndex.get(ch).push(name);
    }
  }

  const grid = Array.from({ length: GEN_CANVAS }, () => Array(GEN_CANVAS).fill(null));
  const words = [];
  const used = new Set();

  function placeWord(name, r0, c0, dir) {
    const dr = dir === 'V' ? 1 : 0, dc = dir === 'H' ? 1 : 0;
    for (let i = 0; i < name.length; i++) grid[r0 + dr * i][c0 + dc * i] = name[i];
    words.push({ name, r: r0, c: c0, dir });
    used.add(name);
  }

  const seeds = names.filter(e => e[1].length >= 5);
  const seed = (seeds.length ? _pick(seeds) : _pick(names))[1];
  const mid = Math.floor(GEN_CANVAS / 2);
  placeWord(seed, mid, Math.floor((GEN_CANVAS - seed.length) / 2), 'H');
  let cellCount = seed.length;

  let fails = 0;
  while (fails < 600 && cellCount < maxCells && words.length < maxWords) {
    const w = _pick(words);
    const k = Math.floor(Math.random() * w.name.length);
    const ch = w.name[k];
    const cr = w.r + (w.dir === 'V' ? k : 0);
    const cc = w.c + (w.dir === 'H' ? k : 0);
    const dir = w.dir === 'H' ? 'V' : 'H';

    const cands = (charIndex.get(ch) || []).filter(n => !used.has(n));
    if (cands.length === 0) { fails++; continue; }
    const cand = _pick(cands);

    const positions = [];
    for (let i = 0; i < cand.length; i++) if (cand[i] === ch) positions.push(i);
    _shuffle(positions);

    let placed = false;
    for (const p of positions) {
      const r0 = dir === 'V' ? cr - p : cr;
      const c0 = dir === 'H' ? cc - p : cc;
      const n = _canPlace(grid, cand, r0, c0, dir);
      if (n !== -1 && cellCount + n <= maxCells) {
        placeWord(cand, r0, c0, dir);
        cellCount += n;
        placed = true;
        break;
      }
    }
    if (placed) fails = 0; else fails++;
  }

  return { grid, words, cellCount };
}

function generatePuzzle(names, maxCells, maxWords) {
  const wordLimit = maxWords || Infinity;
  // 何回か生成して、語数が目標に届いたもの(同数ならマスが多いもの)を採用
  let best = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const p = _tryGenerate(names, maxCells, wordLimit);
    if (!best
      || p.words.length > best.words.length
      || (p.words.length === best.words.length && p.cellCount > best.cellCount)) best = p;
    if (wordLimit !== Infinity && best.words.length >= wordLimit) break;
    if (wordLimit === Infinity && best.cellCount >= maxCells - 8) break;
  }

  const { grid, words, cellCount } = best;

  // 外接矩形で切り出し
  let minR = GEN_CANVAS, maxR = -1, minC = GEN_CANVAS, maxC = -1;
  for (let r = 0; r < GEN_CANVAS; r++) {
    for (let c = 0; c < GEN_CANVAS; c++) {
      if (grid[r][c]) {
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
    }
  }

  const cells = [];
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (grid[r][c]) cells.push({ r: r - minR, c: c - minC, ch: grid[r][c] });
    }
  }

  const normWords = words.map(w => ({ name: w.name, r: w.r - minR, c: w.c - minC, dir: w.dir }));

  // 極大な並び(長さ2以上)を列挙 — 構成上すべて配置した名前と一致する
  const rows = maxR - minR + 1, cols = maxC - minC + 1;
  const has = new Set(cells.map(cl => cl.r + ',' + cl.c));
  const runs = [];
  for (let r = 0; r < rows; r++) {
    let run = [];
    for (let c = 0; c <= cols; c++) {
      if (c < cols && has.has(r + ',' + c)) run.push([r, c]);
      else { if (run.length >= 2) runs.push({ dir: 'H', cells: run }); run = []; }
    }
  }
  for (let c = 0; c < cols; c++) {
    let run = [];
    for (let r = 0; r <= rows; r++) {
      if (r < rows && has.has(r + ',' + c)) run.push([r, c]);
      else { if (run.length >= 2) runs.push({ dir: 'V', cells: run }); run = []; }
    }
  }

  return { rows, cols, cells, words: normWords, runs, cellCount };
}
