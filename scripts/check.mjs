// 한 번에 돌리는 검증. 끝났다고 말하기 전과 커밋 전에 돌린다.
//   npm run check          전부: 안내서 지도 만들기 → 파일 검사 → lint → 단위 테스트 → 원격 통로 함수(Deno) → 화면 검사(Playwright) → 빌드
//   npm run check:fast     커밋 훅용: 안내서 지도 만들기 → 파일 검사 → lint → 단위 테스트 (10초 안팎)
//   node scripts/check.mjs --base=<기준>   land·ship 용: 기준 뒤로 바뀐 파일에 맞는 검사만, 같은 내용이 이미 통과했으면 바로 끝낸다(scripts/check-scope.mjs)
// 하나라도 실패하면 바로 멈추고 어느 단계인지 알려 준다. 화면 검사는 PC 에 깔린 Edge 를 쓰고, Edge 가 없으면(클라우드) 미리 깔린 Chromium, 없으면 Playwright 의 Chromium 을 받아 쓴다. 받기도 못 하면 건너뛴다.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudChromium, hasEdge } from './edge.mjs';
import { denoCheck } from './deno-check.mjs';
import { waitLock } from './check-lock.mjs';
import { buildMap } from './build-guide.mjs';
import { changedFiles, covers, readPasses, rememberPass, scopeOf, treeOf } from './check-scope.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
const BASE = process.argv.find(a => a.startsWith('--base='))?.slice(7);
const need = BASE ? scopeOf(changedFiles(ROOT, BASE)) : { ui: true, land: true };
if (BASE && covers(readPasses(ROOT), treeOf(ROOT), need)) { console.log('\n같은 내용이 이미 통과해 검사를 건너뜁니다'); process.exit(0); }
if (BASE) console.log(`\n검사 범위(${BASE} 뒤로 바뀐 파일 기준): 화면 검사·빌드 ${need.ui ? '돎' : '건너뜀'}, land 시험 ${need.land ? '돎' : '건너뜀'}`);
if (FAST || !need.land) process.env.CHECK_FAST = '1'; // 오래 걸리는 시험(tests/land.test.js 의 실제 git 흐름)을 뺀다
const steps = [];
// 전체 검사는 PC 한 대에 하나씩(다른 작업트리 세션 것과 겹치면 기다림). 빠른 검사(커밋 훅)는 가벼워서 안 기다린다
if (!FAST) { const w = waitLock(ROOT); if (w > 0) console.log(`  앞 검사를 ${w}초 기다렸습니다`); }
const t0 = Date.now();

function step(name, fn) {
  const s = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  const r = fn();
  const sec = ((Date.now() - s) / 1000).toFixed(1);
  steps.push({ name, r, sec });
  if (r === 'fail') { summary(); process.exit(1); }
}
function summary() {
  console.log('\n' + '─'.repeat(50));
  for (const s of steps) console.log(`${s.r === 'ok' ? '✓' : s.r === 'skip' ? '–' : '✗'} ${s.name} (${s.sec}s)${s.r === 'skip' ? ' 건너뜀' : ''}`);
  console.log(`${steps.every(s => s.r !== 'fail') ? '모두 통과' : '실패'} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
}
const run = (cmd, args) => spawnSync([cmd, ...args].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true }).status === 0 ? 'ok' : 'fail'; // Windows 의 npx.cmd 는 셸로만 돈다

/* ── 1. 파일 검사: BOM·빈 파일·셸이 깨뜨린 경로 ── */
// 2026-10-24: PowerShell 5.1 이 쓴 package.json 에 BOM 이 붙어 Vite 가 깨졌다. 셸 백틱이 명령으로 실행돼 문서가 깨진 채 커밋됐다(c4f2eae).
function checkFiles() {
  const files = execSync('git ls-files -z --cached --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const text = /\.(js|mjs|jsx|json|md|css|html|sql|toml|rs|yml|yaml|txt|webmanifest|svg)$/i;
  const bad = [];
  for (const f of files) {
    const p = resolve(ROOT, f);
    if (!existsSync(p) || statSync(p).isDirectory()) continue;
    if (!text.test(f)) continue;
    const buf = readFileSync(p);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${f}: BOM 이 붙어 있음(PowerShell 로 쓴 파일? node 나 Write 도구로 다시 쓰기)`);
    if (buf.length === 0 && !/\.gitkeep$|\.nojekyll$/.test(f)) bad.push(`${f}: 빈 파일`);
    if (/\$[a-z]/.test(f) || /\\/.test(f)) bad.push(`${f}: 이름에 셸 치환 흔적($x)이나 역슬래시`);
    if (f.endsWith('.json')) { try { JSON.parse(buf.toString('utf8')); } catch (e) { bad.push(`${f}: JSON 이 깨짐 (${e.message})`); } }
    // 2026-10-30: 글에 쓴 Windows 경로의 \t 가 문자열 이스케이프로 탭이 되어 "%APPDATA%<탭>odo-agent" 처럼 깨진 채 5곳 커밋됐다
    if (f.endsWith('.md') ? buf.includes(9) : /%[A-Z]+%\t/.test(buf.toString('utf8'))) bad.push(`${f}: 탭 문자가 있음(경로의 \\t 가 깨졌나? 역슬래시로 다시 쓰기)`);
  }
  for (const b of bad) console.log('  ✗ ' + b);
  if (!bad.length) console.log(`  ${files.length}개 파일 이상 없음`);
  return bad.length ? 'fail' : 'ok';
}

/* ── 4. 화면 검사: Edge, 없으면 Playwright 의 Chromium ── */
function uiCheck() {
  if (!hasEdge() && cloudChromium()) console.log(`  Edge 가 없어 미리 깔린 Chromium 을 씁니다(${cloudChromium()})`);
  else if (!hasEdge()) {
    console.log('  Edge 가 없어 Playwright 의 Chromium 을 씁니다(이미 받았으면 바로 넘어감)');
    // 리눅스(클라우드)는 시스템 라이브러리도 함께 받아 본다. 권한이 없으면 브라우저만
    const got = (process.platform === 'linux' && run('npx', ['playwright', 'install', '--with-deps', 'chromium']) === 'ok') || run('npx', ['playwright', 'install', 'chromium']) === 'ok';
    if (!got) { console.log('  Chromium 을 받지 못해 건너뜀(네트워크 제한?). 화면 확인은 이 PC 에서 다시 한다'); return 'skip'; }
  }
  return run('npx', ['playwright', 'test']);
}

step('안내서 지도 만들기', () => { if (buildMap()) console.log('  지도가 달라져 새로 썼습니다(커밋 훅은 저절로 담음. 훅 없이 커밋하면 함께 담기)'); return 'ok'; });
const tree = FAST ? null : treeOf(ROOT); // 지도를 맞춘 뒤의 내용. 검사 중 파일이 바뀌면 기록하지 않는다
step('파일 검사(BOM·JSON·경로)', checkFiles);
step('코드 규칙(eslint)', () => run('npx', ['eslint', '.']));
step('단위 테스트(vitest)', () => run('npx', ['vitest', 'run']));
if (!FAST) {
  step('원격 통로 함수(Deno 형 검사·연기 검사)', denoCheck);
  step('화면 검사(Playwright, PC 폭·375px)', () => (need.ui ? uiCheck() : 'skip'));
  step('빌드(vite build)', () => (need.ui ? run('npx', ['vite', 'build']) : 'skip'));
}
summary();
if (tree && tree === treeOf(ROOT)) rememberPass(ROOT, { tree, ui: steps.every(s => s.r === 'ok'), land: need.land });
