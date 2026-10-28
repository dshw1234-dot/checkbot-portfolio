// 고친 뒤 한 번에: 검사 → 비공개 저장소 맞추기 → 도구 목록 맞추기 → PC 앱 설치 → 폰 배포. 중간에 하나라도 실패하면 거기서 멈춘다.
// 사용: npm run ship                 (모두)
//       npm run ship -- --no-pc       (PC 앱 설치 빼기: 쓰는 중인 앱이 꺼지지 않게)
//       npm run ship -- --no-deploy   (폰 배포 빼기)
//
// 2026-10-26 사용자 결정: 후속 절차(check·sync·pc·deploy)를 명령 하나로 묶고, 로컬 세션 Claude 는 커밋 뒤 이것을 돌린다(CLAUDE.md).
// - 폰 배포: GitHub Actions(.github/workflows/pages.yml)가 켜져 있으면(비밀 PAGES_DEPLOY_KEY 등록) master 에 올라가면 저절로 배포되니
//   여기서는 공개 주소의 판이 HEAD 가 될 때까지 기다리기만 한다. 안 켜져 있으면 npm run deploy 로 직접 올린다.
// - PC 앱: 설치본의 판(설치 폴더 installed-commit.txt) 뒤로 앱에 들어가는 파일이 안 바뀌었으면 건너뛴다(쓰는 중인 앱을 괜히 끄지 않게).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NO_PC = process.argv.includes('--no-pc');
const NO_DEPLOY = process.argv.includes('--no-deploy');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'pages.yml');
const INSTALLED = join(process.env.LOCALAPPDATA || '', 'Todo', 'installed-commit.txt');
// PC 앱에 들어가는 파일. 이것만 바뀌지 않았으면 PC 앱을 다시 깔 필요가 없다
const APP_FILES = 'src public index.html vite.config.js package.json package-lock.json src-tauri';

const sh = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const step = (name, cmd) => {
  console.log(`\n[ship] ▶ ${name}`);
  try { execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); }
  catch { console.log(`\n[ship] ✗ ${name} 에서 멈췄습니다. 위 출력을 보고 고친 뒤 다시 npm run ship`); process.exit(1); }
};
const done = [];

if (process.platform !== 'win32') { console.log('[ship] PC 에서만 돌립니다(클라우드 세션은 가지에 push 만).'); process.exit(1); }
if (sh('git rev-parse --abbrev-ref HEAD') !== 'master') { console.log('[ship] master 가 아닙니다. 가지 작업은 합친 뒤에.'); process.exit(1); }
const dirty = sh('git status --porcelain --untracked-files=no');
if (dirty) { console.log(`[ship] 커밋 안 한 수정이 있어 멈춥니다(자기 파일만 커밋한 뒤 다시):\n${dirty}`); process.exit(1); }

// 1. 검사 2. 비공개 저장소 맞추기
step('검사(npm run check)', 'npm run check');
step('비공개 저장소 맞추기(npm run sync)', 'npm run sync');
if (sh('git rev-list --count origin/master..HEAD') !== '0') { console.log('[ship] ✗ 올리지 못한 커밋이 남았습니다. npm run sync 출력을 보세요.'); process.exit(1); }
const head = sh('git rev-parse --short HEAD');
done.push(`저장소 ${head}`);

// 2-1. 도구 목록(작업 5-10): 서버와 다를 때만 올린다. 통로 로그인이 없거나 서버가 안 되면 알리고 넘어간다(배포를 막지 않게)
try {
  const r = JSON.parse(sh('node tools/todo-agent/todo.mjs tools sync'));
  done.push(r.changed ? `도구 목록 올림(${r.count}줄)` : '도구 목록 같음');
} catch (e) {
  console.log(`\n[ship] ! 도구 목록 맞추기를 건너뜀: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  done.push('도구 목록 건너뜀');
}

// 3. PC 앱(앱 파일이 바뀌었을 때만)
if (NO_PC) done.push('PC 앱 건너뜀(--no-pc)');
else if (pcUpToDate()) done.push('PC 앱은 바뀐 것이 없어 건너뜀');
else { step('PC 앱 빌드·설치(npm run pc)', 'npm run pc'); done.push(`PC 앱 ${head}`); }

// 4. 폰 배포
if (NO_DEPLOY) done.push('폰 배포 건너뜀(--no-deploy)');
else if (ciDeployOn()) {
  step('폰 배포: GitHub Actions 가 올리는 것을 기다림', 'node scripts/deploy-pages.mjs --check --wait 480');
  done.push(`폰 ${head}(GitHub Actions)`);
} else {
  step('폰 배포(npm run deploy)', 'npm run deploy');
  done.push(`폰 ${head}`);
}

console.log(`\n[ship] ✓ 끝: ${done.join(' · ')}`);

function pcUpToDate() {
  if (!existsSync(INSTALLED)) return false;
  const installed = readFileSync(INSTALLED, 'utf8').trim();
  try { execSync(`git diff --quiet ${installed} HEAD -- ${APP_FILES}`, { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch { return false; } // 바뀐 것이 있거나 모르는 판(-dirty 등)
}

function ciDeployOn() {
  if (!existsSync(WORKFLOW)) return false;
  try { return /^PAGES_DEPLOY_KEY\b/m.test(sh('gh secret list --repo dshw1234-dot/todo-app-src')); }
  catch { return false; } // gh 가 없거나 로그인 안 됨 → 직접 배포
}
