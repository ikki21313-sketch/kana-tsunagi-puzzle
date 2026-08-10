// pokedata.json ([id, name, speed][]) → names.js (カナのみの名前 [id, name][])
//
// pokedata.json は pokemon-speed-quiz プロジェクトで PokeAPI の CSV から生成したもの。
// 実行: node scripts/gen-names.mjs [pokedata.json のパス]
// (省略時は隣の pokemon-speed-quiz リポジトリを参照)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2]
  ?? join(here, '..', '..', 'pokemon-speed-quiz', 'src', 'data', 'pokedata.json');
const out = join(here, '..', 'names.js');

const data = JSON.parse(readFileSync(src, 'utf8'));
// カタカナ+長音のみ許可（♂♀・数字・記号入りの名前は除外）
const kanaOnly = /^[ァ-ヶー]+$/;

const entries = [];
const excluded = [];
for (const [id, name] of data) {
  if (kanaOnly.test(name)) entries.push([id, name]);
  else excluded.push(name);
}

const lens = entries.map(e => e[1].length);
console.log('included:', entries.length, 'excluded:', excluded.join(' '));
console.log('min len:', Math.min(...lens), 'max len:', Math.max(...lens));

const body = entries.map(e => JSON.stringify(e)).join(',\n');
writeFileSync(out, '// generated from pokemon-speed-quiz/src/data/pokedata.json\nconst POKEMON_NAMES = [\n' + body + '\n];\n', 'utf8');
console.log('written:', out);
