// 고친 뒤 한 번에: 검사 → 도구 목록 맞추기 → 비공개 저장소 맞추기 → PC 앱 설치 → 폰 배포 → 원격 통로 함수. 중간에 하나라도 실패하면 거기서 멈춘다.
// 사용: npm run ship                 (모두)
//       npm run ship -- --no-pc       (PC 앱 설치 빼기: 쓰는 중인 앱이 꺼지지 않게)
//       npm run ship -- --no-deploy   (폰 배포 빼기)
//       npm run ship -- --no-fn       (원격 통로 함수 빼기)
//       npm run ship -- --no-watch    (PC 감시자 다시 켜기 빼기)
//
// 2026-10-26 사용자 결정: 후속 절차(check·sync·pc·deploy)를 명령 하나로 묶고, 로컬 세션 Claude 는 커밋 뒤 이것을 돌린다(CLAUDE.md).
// - 폰 배포: GitHub Actions(.github/workflows/pages.yml)가 켜져 있으면(비밀 PAGES_DEPLOY_KEY 등록) master 에 올라가면 저절로 배포되니
//   여기서는 공개 주소의 판이 HEAD 가 될 때까지 기다리기만 한다. 안 켜져 있으면 npm run deploy 로 직접 올린다.
// - 2026-11-01: 폰 배포 기다림(최대 15분)은 잠금을 푼 뒤 맨 끝에 한다. 잠금을 쥔 채 기다리다 다른 세션이 21분 줄을 섰다.
// - 2026-11-01 사용자 결정: 웹 앱 파일이 공개 판 뒤로 안 바뀌었으면 폰 배포와 기다림을 건너뛴다(10-31 이후 커밋 40개 중 28개). 공개 판 번호는 그대로 남는다.
// - PC 앱: 설치본의 판(설치 폴더 installed-commit.txt) 뒤로 앱에 들어가는 파일이 안 바뀌었으면 건너뛴다(쓰는 중인 앱을 괜히 끄지 않게).
// - 원격 통로 함수(2026-10-30 점검 후보 A): 올린 판(PC 의 fn-deployed-commit.txt) 뒤로 함수에 실리는 파일이 바뀌었을 때만 올린다(scripts/deploy-fn.mjs).
// - PC 감시자(2026-11-01 사용자 요청): 켜진 뒤 코드가 바뀌었으면 다시 켠다(scripts/watch-autostart.mjs --restart). 실행 중이면 끊지 않고 알리기만, 실패해도 배포는 끝난 것이니 멈추지 않는다.
// - 계정 스킬(claude.ai 에 zip 으로 올림)은 ship 이 못 올린다. 올린 판(skills/uploaded-commit.txt) 뒤로 바뀌었으면 끝에 알리기만 한다.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYED, FN_FILES } from './deploy-fn.mjs';
import { shipLock, waitShipLock } from './land.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NO_PC = process.argv.includes('--no-pc');
const NO_DEPLOY = process.argv.includes('--no-deploy');
const NO_FN = process.argv.includes('--no-fn');
const NO_WATCH = process.argv.includes('--no-watch');
const LAND = process.argv.find(a => a.startsWith('--land='))?.slice(7); // scripts/land.mjs 가 부름: 잠금은 그쪽이 쥐고, 값은 검사를 마친 커밋(없으면 빈 값)
const WORKFLOW = join(ROOT, '.github', 'workflows', 'pages.yml');
const INSTALLED = join(process.env.LOCALAPPDATA || '', 'Todo', 'installed-commit.txt');
// PC 앱에 들어가는 파일. 이것만 바뀌지 않았으면 PC 앱을 다시 깔 필요가 없다
const APP_FILES = 'src public index.html vite.config.js package.json package-lock.json src-tauri';
// 폰(웹)에 들어가는 파일. .github/workflows/pages.yml 의 paths 와 같게 둔다(tests/ship.test.js)
const PAGES_FILES = 'src public index.html vite.config.js package.json package-lock.json';
const PAGES_RUN = 'gh workflow run pages.yml --repo dshw1234-dot/todo-app-src --ref master';
// 계정 스킬에 들어가는 파일. 도구_목록.md 는 서버 설정으로 맞추고(tools sync), 시험_대본.md 는 zip 에 넣지 않는다
const SKILL_FILES = 'skills/todo-agent ":!skills/todo-agent/references/도구_목록.md" ":!skills/todo-agent/시험_대본.md"';
const UPLOADED = join(ROOT, 'skills', 'uploaded-commit.txt');

const sh = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const step = (name, cmd) => {
  console.log(`\n[ship] ▶ ${name}`);
  try { execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); }
  catch { console.log(`\n[ship] ✗ ${name} 에서 멈췄습니다. 위 출력을 보고 고친 뒤 다시 npm run ship`); process.exit(1); }
};
const done = [];

if (process.platform !== 'win32') { console.log('[ship] PC 에서만 돌립니다(클라우드 세션은 가지에 push 만).'); process.exit(1); }
if (LAND === undefined && !waitShipLock(ROOT)) process.exit(1); // 2026-11-01: 세션 여러 개의 합치기·배포가 겹쳤다
if (sh('git rev-parse --abbrev-ref HEAD') !== 'master') { console.log('[ship] master 가 아닙니다. 가지 작업은 합친 뒤에.'); process.exit(1); }
const dirty = sh('git status --porcelain --untracked-files=no');
if (dirty) { console.log(`[ship] 커밋 안 한 수정이 있어 멈춥니다(자기 파일만 커밋한 뒤 다시):\n${dirty}`); process.exit(1); }

// 1. 검사 2. 비공개 저장소 맞추기
if (LAND && LAND === sh('git rev-parse HEAD')) console.log('\n[ship] 검사는 land 가 이 커밋으로 마쳤습니다');
else step('검사(올릴 커밋이 바꾼 파일에 맞게)', 'node scripts/check.mjs --base=origin/master');

// 1-1. 도구 목록(작업 5-10): 파일과 서버 설정을 맞춘다. 앱 설정에서 고친 것(X-23)을 받아 쓰면 그 파일만 로컬 커밋하니, 올리기(sync) 앞에 둔다.
//      통로 로그인이 없거나 서버가 안 되면 알리고 넘어간다(배포를 막지 않게)
//      그 앞에 Claude 앱의 새 환경을 도구_목록.md 에 더한다(X-29). 감시자가 꺼져 있어도 ship 때 들어가게
let toolsDone, envNotes = [];
try {
  const e = JSON.parse(sh('node tools/todo-agent/todo.mjs tools envs'));
  envNotes = e.error ? [e.error] : e.notes;
  if (e.added.length) done.push(`앱 환경 더함(${e.added.join(', ')})`);
} catch (e) {
  console.log(`\n[ship] ! 앱 환경 확인을 건너뜀: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
}
try {
  const r = JSON.parse(sh('node tools/todo-agent/todo.mjs tools sync'));
  toolsDone = !r.changed ? '도구 목록 같음'
    : r.dir === 'up' ? `도구 목록 올림(${r.count}줄)`
    : `도구 목록 앱에서 고친 것 받음(${r.count}줄${r.committed ? ', 커밋' : ', 커밋 안 함: 파일에 다른 수정'})`;
} catch (e) {
  console.log(`\n[ship] ! 도구 목록 맞추기를 건너뜀: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  toolsDone = '도구 목록 건너뜀';
}
const pushedFrom = sh('git rev-parse origin/master');
step('비공개 저장소 맞추기(npm run sync)', 'npm run sync');
if (sh('git rev-list --count origin/master..HEAD') !== '0') { console.log('[ship] ✗ 올리지 못한 커밋이 남았습니다. npm run sync 출력을 보세요.'); process.exit(1); }
const head = sh('git rev-parse --short HEAD');
done.push(`저장소 ${head}`, toolsDone);

// 3. PC 앱(앱 파일이 바뀌었을 때만)
if (NO_PC) done.push('PC 앱 건너뜀(--no-pc)');
else if (pcUpToDate()) done.push('PC 앱은 바뀐 것이 없어 건너뜀');
else { step('PC 앱 빌드·설치(npm run pc)', 'npm run pc'); done.push(`PC 앱 ${head}`); }

// 4. 폰 배포(웹 앱 파일이 공개 판 뒤로 바뀌었을 때만)
const published = NO_DEPLOY ? '' : phoneUpToDate();
let phoneWait = false;
if (NO_DEPLOY) done.push('폰 배포 건너뜀(--no-deploy)');
else if (published) done.push(`폰은 바뀐 것이 없어 건너뜀(공개 판 ${published})`);
else if (ciDeployOn()) {
  // pages.yml 은 웹 앱 파일이 든 push 에만 돈다. 앞서 못 올린 판을 이 push 가 안 건드렸으면 직접 돌린다
  if (!pushTouchesPages()) step('폰 배포: 앞서 못 올린 판을 GitHub Actions 로 돌림', PAGES_RUN);
  // 올린 커밋을 기다린다. 그 사이 PC 감시자가 도구 목록을 로컬 커밋해 HEAD 가 움직여도 헛기다리지 않게(2026-11-01)
  phoneWait = true;
  done.push(`폰 ${head}(GitHub Actions)`);
} else {
  step('폰 배포(npm run deploy)', 'npm run deploy');
  done.push(`폰 ${head}`);
}

// 5. 원격 통로 함수(함수에 실리는 파일이 바뀌었을 때만)
const fn = NO_FN ? [] : fnChanged();
if (NO_FN) done.push('함수 건너뜀(--no-fn)');
else if (!fn.length) done.push('함수는 바뀐 것이 없어 건너뜀');
else { step('원격 통로 함수 올리기(scripts/deploy-fn.mjs)', 'node scripts/deploy-fn.mjs'); done.push(`함수 ${head}`); }

// 6. PC 감시자(켜진 뒤 코드가 바뀌었을 때만)
if (NO_WATCH) done.push('감시자 건너뜀(--no-watch)');
else {
  try { done.push(sh('node scripts/watch-autostart.mjs --restart')); }
  catch (e) {
    console.log(`\n[ship] ! 감시자 다시 켜기를 못 함: ${String(e.stderr || e.message).trim().split('\n').find(l => /Error:/.test(l)) || e.message}`);
    done.push('감시자 다시 켜기 못 함');
  }
}

// 7. 폰 기다림: 합치기·배포는 끝났으니 잠금을 풀고 기다린다. land 가 부른 때는 land 가 쥔 잠금을 여기서 푼다(land 의 끝 처리는 자기 잠금만 지운다)
if (phoneWait) {
  rmSync(shipLock(ROOT), { force: true });
  const wait = secs => `node scripts/deploy-pages.mjs --check --wait ${secs} --commit ${head}`;
  console.log('\n[ship] ▶ 폰 배포: GitHub Actions 가 올리는 것을 기다림(잠금은 풀었습니다)');
  // 평소 1~2분. 공개 저장소의 Pages 는 앞 배포가 도는 중이면 새 배포를 거절하니(in progress deployment, 2026-11-01), 안 올라가면 한 번 다시 돌린다
  try { execSync(wait(300), { cwd: ROOT, stdio: 'inherit' }); }
  catch {
    step('폰 배포: 공개 저장소의 배포가 겹쳤을 수 있어 다시 돌림', PAGES_RUN);
    step('폰 배포: 다시 돌린 것을 기다림', wait(600));
  }
}

const skill = skillChanged();
if (skill.length) done.push(`계정 스킬 다시 올릴 것(${skill.length}개 파일)`);
console.log(`\n[ship] ✓ 끝: ${done.join(' · ')}`);
if (envNotes.length) console.log(`[ship] ! Claude 앱 환경과 도구 목록이 다름(저절로 고치지 않음):\n  ${envNotes.join('\n  ')}`);
if (fn.some(f => f.endsWith('todo-mcp/tools.js'))) console.log("[ship] ! 도구 설명(tools.js)이 바뀜: 대화에서 승인을 다시 물으면 claude.ai → 커넥터 '체크봇' → 내 도구 권한에서 고른다");
if (skill.length) console.log(`[ship] ! 계정 스킬이 올린 판 뒤로 바뀜: ${skill.join(', ')}\n  → skills/todo-agent/references/설정.md 의 올리는 법대로 교체한 뒤 skills/uploaded-commit.txt 를 그 판으로`);

function pcUpToDate() {
  if (!existsSync(INSTALLED)) return false;
  const installed = readFileSync(INSTALLED, 'utf8').trim();
  try { execSync(`git diff --quiet ${installed} HEAD -- ${APP_FILES}`, { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch { return false; } // 바뀐 것이 있거나 모르는 판(-dirty 등)
}

// 공개 판 뒤로 웹 앱 파일이 안 바뀌었으면 그 판, 바뀌었거나 모르면 빈 글
function phoneUpToDate() {
  try {
    const pub = sh('node scripts/deploy-pages.mjs --published');
    execSync(`git diff --quiet ${pub} HEAD -- ${PAGES_FILES}`, { cwd: ROOT, stdio: 'ignore' });
    return pub;
  } catch { return ''; }
}

function pushTouchesPages() {
  try { execSync(`git diff --quiet ${pushedFrom} HEAD -- ${PAGES_FILES}`, { cwd: ROOT, stdio: 'ignore' }); return false; }
  catch { return true; }
}

// 올린 판 뒤로 바뀐 함수 파일. 기록이 없거나 모르는 판(-dirty 등)이면 올린다
function fnChanged() {
  const rec = existsSync(DEPLOYED) ? readFileSync(DEPLOYED, 'utf8').trim() : '';
  if (!rec) return ['(올린 기록 없음)'];
  try { return sh(`git diff --name-only ${rec} HEAD -- ${FN_FILES.join(' ')}`).split('\n').filter(Boolean); }
  catch { return [`(모르는 판 ${rec})`]; }
}

function skillChanged() {
  if (!existsSync(UPLOADED)) return [];
  try { return sh(`git -c core.quotepath=false diff --name-only ${readFileSync(UPLOADED, 'utf8').trim()} HEAD -- ${SKILL_FILES}`).split('\n').filter(Boolean); }
  catch { return []; } // 모르는 판
}

function ciDeployOn() {
  if (!existsSync(WORKFLOW)) return false;
  try { return /^PAGES_DEPLOY_KEY\b/m.test(sh('gh secret list --repo dshw1234-dot/todo-app-src')); }
  catch { return false; } // gh 가 없거나 로그인 안 됨 → 직접 배포
}
