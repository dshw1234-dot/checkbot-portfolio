// 전체 검사의 범위와 통과 기록. land·ship 이 바뀐 파일에 맞는 검사만 돌리고, 같은 내용은 다시 돌리지 않게 한다.
// 2026-11-01 사용자 결정: 10-31 이후 커밋 40개 중 28개가 화면과 상관없는데 모두 화면 검사(약 150초)와 tests/land.test.js(약 75초)를 돌아, 문서 한 줄에도 잠금을 5분 쥐었다.
// 건너뛰는 경로는 허용 목록으로만 정한다. 목록에 없는 파일이 바뀌거나 범위를 모르면 전부 돈다. 손으로 돌리는 npm run check 는 언제나 전부다.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 화면·빌드에 들어가지 않는 경로. 화면 시험 설정이 부르는 edge.mjs 와 검사 자신은 뺀다(고치면 전부 돈다)
const NO_UI = [/^docs\//, /^skills\//, /^tools\//, /^supabase\//, /^scripts\/(?!edge\.mjs$|check\.mjs$|check-scope\.mjs$)/, /^tests\/(?!ui\/)/, /^\.githooks\//, /^\.github\//, /^\.claude\//, /^\.gitattributes$/, /^CLAUDE\.md$/, /^README/];
// tests/land.test.js 가 실제로 돌리는 파일(setup 이 임시 저장소에 복사하는 것과 그 시험 자신)
export const LAND_FILES = ['scripts/land.mjs', 'scripts/check-lock.mjs', '.gitattributes', 'tests/land.test.js'];
const PASS_MAX = 20; // 세션마다 하나씩이면 충분하다

const git = (cmd, cwd, env) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } }).trim();

// 바뀐 파일 → 돌릴 검사. 파일 목록이 비면 범위를 모르는 것이니 전부
export function scopeOf(files) {
  if (!files.length) return { ui: true, land: true };
  return {
    ui: files.some(f => !NO_UI.some(re => re.test(f))),
    land: files.some(f => LAND_FILES.includes(f)),
  };
}

// base 뒤로 바뀐 파일. 이름 바꾸기는 옛 경로도 담는다(src/ 에서 tools/ 로 옮겨도 화면 검사가 돌게)
export function changedFiles(root, base) {
  try { return git(`-c core.quotepath=false diff --no-renames --name-only ${base}...HEAD`, root).split('\n').filter(Boolean); }
  catch { return []; }
}

// 작업 폴더 내용의 해시(커밋 안 한 것·새 파일 포함, 무시 파일 제외). 깨끗하면 HEAD 의 트리와 같다. 진짜 인덱스는 건드리지 않는다
export function treeOf(root) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'check-tree-'));
    const index = join(dir, 'index');
    copyFileSync(resolve(root, git('rev-parse --git-path index', root)), index);
    git('add -A', root, { GIT_INDEX_FILE: index });
    return git('write-tree', root, { GIT_INDEX_FILE: index });
  } catch { return null; } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

export const covers = (passes, tree, need) => passes.some(p => p.tree === tree && (p.ui || !need.ui) && (p.land || !need.land));

// 같은 내용의 앞 기록과 합친다(전부 통과한 기록을 범위 통과가 덮지 않게)
export function addPass(passes, pass) {
  const old = passes.find(p => p.tree === pass.tree);
  const merged = old ? { tree: pass.tree, ui: old.ui || pass.ui, land: old.land || pass.land } : pass;
  return [merged, ...passes.filter(p => p.tree !== pass.tree)].slice(0, PASS_MAX);
}

// 워크트리가 함께 쓰는 곳에 둔다: 가지에서 통과한 내용을 land 가 그대로 합칠 때도 쓴다
const passFile = root => join(resolve(root, git('rev-parse --git-common-dir', root)), 'todo-app-check-pass.json');

export function readPasses(root) {
  try { const list = JSON.parse(readFileSync(passFile(root), 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
}

export function rememberPass(root, pass) {
  try { writeFileSync(passFile(root), JSON.stringify(addPass(readPasses(root), pass))); } catch { /* 기록을 못 해도 다음에 다시 돌 뿐이다 */ }
}
