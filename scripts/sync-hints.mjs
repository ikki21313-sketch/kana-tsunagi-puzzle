// PokeAPI が GitHub で公開している CSV から種族値(6つ)と日本語図鑑説明文を
// 取得し、hints.js を生成する。
//
// PokeAPI フェアユースポリシー準拠のため:
// - API サーバー (pokeapi.co) には一切アクセスしない
// - 実行は開発者の手動実行のみ。CI に組み込まないこと
// 図鑑説明文はゲーム本編からの引用。権利の帰属と非商用・出典明示の扱いは
// README.md「権利・ライセンス」/ THIRD_PARTY_NOTICES.md を参照。
//
// 実行: node scripts/sync-hints.mjs

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSV_BASE =
  "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv";
const MAX_ID = 1025;
const LANG_JA = 11; // 日本語
const LANG_JA_HRKT = 1; // 日本語(かなカナ) フォールバック

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "hints.js");

/** 引用符・引用符内カンマに対応した最小限の CSV パーサ */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

async function fetchCsv(name) {
  const url = `${CSV_BASE}/${name}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${name}: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

const [statsRows, flavorRows, nameRows, typeRows, typeNameRows] = await Promise.all([
  fetchCsv("pokemon_stats.csv"),
  fetchCsv("pokemon_species_flavor_text.csv"),
  fetchCsv("pokemon_species_names.csv"),
  fetchCsv("pokemon_types.csv"),
  fetchCsv("type_names.csv"),
]);

// pokemon_stats.csv: pokemon_id,stat_id,base_stat,effort
// stat_id 1..6 = HP, こうげき, ぼうぎょ, とくこう, とくぼう, すばやさ
const stats = new Map();
for (const [pokemonId, statId, baseStat] of statsRows.slice(1)) {
  const id = Number(pokemonId);
  const s = Number(statId);
  if (id < 1 || id > MAX_ID || s < 1 || s > 6) continue;
  if (!stats.has(id)) stats.set(id, [0, 0, 0, 0, 0, 0]);
  stats.get(id)[s - 1] = Number(baseStat);
}

// pokemon_species_flavor_text.csv: species_id,version_id,language_id,flavor_text
// 各種族で最も新しいバージョンの日本語説明文を採用し、先頭10文字だけ残す
const flavor = new Map(); // id -> {ver, text}
const flavorHrkt = new Map();
for (const [speciesId, versionId, langId, text] of flavorRows.slice(1)) {
  const id = Number(speciesId);
  if (id < 1 || id > MAX_ID) continue;
  const lang = Number(langId);
  const ver = Number(versionId);
  const target = lang === LANG_JA ? flavor : lang === LANG_JA_HRKT ? flavorHrkt : null;
  if (!target) continue;
  if (!target.has(id) || target.get(id).ver < ver) target.set(id, { ver, text });
}

function clean(text) {
  return text.replace(/[\s　]+/g, "");
}

// pokemon_species_names.csv: pokemon_species_id,local_language_id,name,genus
// 新しい世代(No.899〜)は日本語説明文が CSV に無いため「ぶんるい」で代用する
const genus = new Map();
for (const [speciesId, langId, , g] of nameRows.slice(1)) {
  const id = Number(speciesId);
  if (id < 1 || id > MAX_ID || Number(langId) !== LANG_JA || !g) continue;
  genus.set(id, g);
}

// type_names.csv: type_id,local_language_id,name — 日本語タイプ名
const typeNames = new Map();
for (const [typeId, langId, name] of typeNameRows.slice(1)) {
  if (Number(langId) === LANG_JA) typeNames.set(Number(typeId), name);
}

// pokemon_types.csv: pokemon_id,type_id,slot — 図鑑 No.1〜1025 では pokemon_id と一致
const types = new Map();
for (const [pokemonId, typeId, slot] of typeRows.slice(1)) {
  const id = Number(pokemonId);
  if (id < 1 || id > MAX_ID) continue;
  if (!types.has(id)) types.set(id, []);
  types.get(id)[Number(slot) - 1] = typeNames.get(Number(typeId));
}

// hints[id] = [ヒント文, [H,A,B,C,D,S], 0=図鑑説明文/1=ぶんるい/2=タイプ]
const hints = {};
const missing = [];
let genusCount = 0, typeCount = 0;
for (let id = 1; id <= MAX_ID; id++) {
  const st = stats.get(id);
  const fl = flavor.get(id) ?? flavorHrkt.get(id);
  const g = genus.get(id);
  const ty = (types.get(id) || []).filter(Boolean);
  if (!st || st.some((v) => !Number.isInteger(v) || v <= 0) || (!fl && !g && !ty.length)) {
    missing.push(id);
    continue;
  }
  if (fl) {
    hints[id] = [clean(fl.text), st, 0];
  } else if (g) {
    hints[id] = [g, st, 1];
    genusCount++;
  } else {
    hints[id] = [ty.join("・"), st, 2];
    typeCount++;
  }
}
console.log(`ぶんるいで代用: ${genusCount}件, タイプで代用: ${typeCount}件`);

if (missing.length > 0) {
  console.error(`ERROR: missing data for ${missing.length} ids: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}`);
  process.exit(1);
}

const body = JSON.stringify(hints);
await writeFile(
  outPath,
  "// generated by scripts/sync-hints.mjs — 図鑑説明文はゲーム本編からの引用(権利表記は README/THIRD_PARTY_NOTICES.md 参照)\n" +
    "const POKEMON_HINTS = " + body + ";\n",
  "utf8",
);
console.log(`wrote ${outPath}`);
console.log(`entries: ${Object.keys(hints).length}, size: ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
console.log("sample #25:", JSON.stringify(hints[25]));
console.log("sample #1025:", JSON.stringify(hints[1025]));
