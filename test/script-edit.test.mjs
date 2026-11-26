import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildEvents, planPreEvents, applyFileRoutes, scriptsInCommand, changesFromScriptText,
  snapshotShell, shellChangeEvents, isReadOnlyCommand, shellCommandOf, noteShown, eventsFromHunks, isTestFile,
} from '../hook.mjs';

function project(files, prefix = 'ac-script-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
const slash = (p) => p.split(path.sep).join('/');

const BOARD = [
  'import { Coffee } from "@/components/icons";',
  'export function TeamBoardContent() {',
  '  return (',
  '    <section className="team-board flex flex-col gap-4">',
  '      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">',
  '        <Tile label="online" />',
  '      </div>',
  '      <table className="w-full min-w-[960px] text-sm"><tbody><tr className="board-row"><td>Ada</td></tr></tbody></table>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

const NEXT = {
  'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } }),
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
  'src/app/layout.tsx': 'export default function L({ children }) { return <html><body>{children}</body></html>; }\n',
  'src/app/(dashboard)/dashboard/page.tsx': 'export default function D() { return <main className="dash-home">Ana</main>; }\n',
  'src/app/(dashboard)/dashboard/team/page.tsx': 'import { TeamBoardContent } from "@/components/dashboard/team/TeamBoardContent";\nexport default function P() { return <TeamBoardContent />; }\n',
  'src/components/dashboard/team/TeamBoardContent.tsx': BOARD,
  'src/api/types.ts': 'export type TeamState = "online" | "idle";\n',
};

test('python script dosyası: cd + "$PWD" argümanı + edit(p, [(eski, yeni)]) → değişen elemanlar, sayfa URL\'si', () => {
  const root = project(NEXT);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scratch-'));
  const script = path.join(scratch, 'web_board.py');
  fs.writeFileSync(script, [
    'import io', 'import os', 'import sys', '', 'root = sys.argv[1]', '',
    'def edit(p, pairs):',
    '    full = os.path.join(root, p)',
    "    s = io.open(full, encoding='utf-8').read()",
    '    for old, new in pairs:',
    '        assert s.count(old) == 1, (p, s.count(old), old[:70])',
    '        s = s.replace(old, new)',
    "    io.open(full, 'w', encoding='utf-8', newline='').write(s)",
    '',
    "edit('src/components/dashboard/team/TeamBoardContent.tsx', [",
    "    ('''      <div className=\"grid grid-cols-2 gap-3 md:grid-cols-6\">''',",
    "     '''      <div className=\"grid grid-cols-2 gap-3 md:grid-cols-7\">'''),",
    "    ('min-w-[960px]', 'min-w-[1120px]'),",
    '])',
    "edit('src/api/types.ts', [('\"online\" | \"idle\"', '\"online\" | \"idle\" | \"meeting\"')])",
    '',
  ].join('\n'));
  const command = `cd "${slash(root)}" && python -I "${slash(script)}" "$PWD" < /dev/null && git diff --stat`;
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command } };
  const events = applyFileRoutes(buildEvents(input));
  const board = events.filter((e) => e.file.endsWith('TeamBoardContent.tsx'));
  assert.ok(board.length >= 2, `iki değişiklik, iki imleç: ${JSON.stringify(events.map((e) => e.hint))}`);
  assert.ok(board.some((e) => e.hint.classes.includes('md:grid-cols-6')), 'grid satırı (sayfada ŞU AN olan sınıf)');
  assert.ok(board.some((e) => e.hint.tag === 'table' || e.hint.classes.includes('min-w-[960px]')), 'tablo');
  assert.ok(board.every((e) => e.url === '/dashboard/team'), 'değişikliğin sayfası');
  assert.ok(board.every((e) => e.phase === 'pre'));
  assert.equal(events.filter((e) => e.file.endsWith('types.ts')).length, 0, 'görsel olmayan .ts imleç almaz');
  assert.equal(fs.readFileSync(path.join(root, 'src/components/dashboard/team/TeamBoardContent.tsx'), 'utf8'), BOARD);
});

test('python heredoc: p değişkeni + pairs listesi; S="..." ile script yolu', () => {
  const root = project(NEXT);
  const heredoc = [
    `cd "${slash(root)}" && python - <<'PYEOF'`,
    'import io',
    "p = 'src/components/dashboard/team/TeamBoardContent.tsx'",
    "s = io.open(p, encoding='utf-8').read()",
    'pairs = [',
    "('''<tr className=\"board-row\">''', '''<tr className=\"board-row hover:bg-subtle\">'''),",
    ']',
    'for old, new in pairs:',
    '    assert s.count(old) == 1, old',
    '    s = s.replace(old, new)',
    "io.open(p, 'w', encoding='utf-8', newline='').write(s)",
    "print('ok')",
    'PYEOF',
  ].join('\n');
  const evs = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: heredoc } });
  assert.ok(evs && evs.length >= 1);
  assert.ok(evs.some((e) => e.hint.classes.includes('board-row')), JSON.stringify(evs.map((e) => e.hint)));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scratch-'));
  fs.writeFileSync(path.join(scratch, 'fix.py'), [
    'import sys',
    'def rep(p, old, new):',
    '    t = open(p, encoding="utf-8").read(); assert old in t; open(p, "w", encoding="utf-8", newline="").write(t.replace(old, new, 1))',
    'rep("src/components/dashboard/team/TeamBoardContent.tsx", "team-board flex flex-col gap-4", "team-board flex flex-col gap-6")',
    'rep("README.md", "flex flex-col", "x")',
  ].join('\n'));
  const command = `cd "${slash(root)}" && S="${slash(scratch)}" && python -I "$S/fix.py"`;
  const out = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command } });
  assert.ok(out && out.some((e) => e.hint.classes.includes('team-board')), JSON.stringify(out));
});

test('python -c ve node -e; .cs/.md dosyasına ait çift FE dosyasına uygulanmaz', () => {
  const root = project(NEXT);
  const pyc = `cd "${slash(root)}" && python -c "p='src/components/dashboard/team/TeamBoardContent.tsx'; s=open(p).read(); open(p,'w').write(s.replace('text-sm\\"', 'text-xs\\"'))"`;
  const a = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: pyc } });
  assert.ok(a && a.length, 'python -c');

  const nodeE = `node -e "const fs=require('fs');const p='src/components/dashboard/team/TeamBoardContent.tsx';let s=fs.readFileSync(p,'utf8');s=s.replace('gap-3 md:grid-cols-6','gap-2 md:grid-cols-6');fs.writeFileSync(p,s)"`;
  const b = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: nodeE } });
  assert.ok(b && b.some((e) => e.hint.classes.includes('md:grid-cols-6')), JSON.stringify(b));

  const text = [
    "rep('server/Controllers/UsersController.cs', 'flex flex-col gap-4', 'x')",
    "rep('src/components/dashboard/team/TeamBoardContent.tsx', 'board-row', 'board-row2')",
  ].join('\n');
  const changes = changesFromScriptText(text, 'py', [root]);
  assert.equal(changes.length, 1);
  assert.ok(!changes[0].after.includes('"x"') && changes[0].after.includes('board-row2'), '.cs çifti tsx\'e uygulanmadı');
});

test('script ile yeni bileşen: node writeFileSync + python Path.write_text → created olayları', () => {
  const root = project(NEXT);
  const content = 'export function ClosedBy() {\n  return <span className="closed-by inline-flex flex-col gap-0.5"><b className="closed-by-name">Ada</b></span>;\n}\n';
  const js = `const fs = require('fs');\nfs.writeFileSync('src/components/dashboard/conversation/ClosedBy.tsx', ${JSON.stringify(content)});\n`;
  const ch = changesFromScriptText(js, 'js', [root]);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].before, null);
  assert.equal(ch[0].after, content);
  const py = `from pathlib import Path\nPath('src/components/dashboard/conversation/ClosedBy.tsx').write_text('''${content}''', encoding='utf-8')\n`;
  const command = `cd "${slash(root)}" && python - <<'EOF'\n${py}EOF`;
  const evs = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } });
  assert.ok(evs && evs.length && evs.every((e) => e.created === true), JSON.stringify(evs));
  assert.ok(evs.some((e) => e.next && e.next.classes.includes('closed-by')));
});

test('scriptsInCommand: PowerShell here-string, Codex dizi komutu, -m modülü atlanır', () => {
  const root = project(NEXT);
  const ps = `Set-Location "${root}"; @'\nprint(1)\n'@ | python -`;
  assert.equal(scriptsInCommand(ps, root).length, 1);
  assert.equal(scriptsInCommand('python -m pytest -q', root).length, 0);
  assert.equal(shellCommandOf({ command: ['bash', '-lc', 'python x.py'] }), 'python x.py');
});

test('isReadOnlyCommand: okuma komutları anlık görüntü almaz, yazanlar alır', () => {
  assert.equal(isReadOnlyCommand('cd "c:/x" && grep -n "a" src/a.tsx | head -5; sed -n 1,20p a.tsx'), true);
  assert.equal(isReadOnlyCommand('git status --short && git diff --stat'), true);
  assert.equal(isReadOnlyCommand('ls src 2>/dev/null; wc -l a.ts'), true);
  assert.equal(isReadOnlyCommand('python -I fix.py "$PWD"'), false);
  assert.equal(isReadOnlyCommand('sed -i s/a/b/ a.tsx'), false);
  assert.equal(isReadOnlyCommand('echo x > a.tsx'), false);
  assert.equal(isReadOnlyCommand('git checkout -- src/a.tsx'), false);
  assert.equal(isReadOnlyCommand('npx prettier --write src'), false);
});

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

test('git yedeği: Pre anlık görüntüsü + Post farkı; Pre\'de gösterilen dosya tekrar gösterilmez', () => {
  const root = project({ ...NEXT, 'src/components/Other.tsx': 'export function Other() { return <p className="other-note">Not</p>; }\n' }, 'ac-git-');
  git(root, 'init', '-q');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  const boardFile = path.join(root, 'src/components/dashboard/team/TeamBoardContent.tsx');
  fs.writeFileSync(boardFile, BOARD.replace('team-board flex', 'team-board shadow flex'));
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-snap-'));
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_test_1', cwd: root, tool_input: { command: 'npx some-codemod src' } };
  assert.equal(snapshotShell(input, [], { dir: snapDir }), true);
  const t = Date.now() / 1000 + 2;
  fs.writeFileSync(boardFile, fs.readFileSync(boardFile, 'utf8').replace('<tr className="board-row">', '<tr className="board-row is-live">'));
  fs.utimesSync(boardFile, t, t);
  fs.writeFileSync(path.join(root, 'src/components/Other.tsx'), 'export function Other() { return <p className="other-note text-muted">Not</p>; }\n');
  fs.writeFileSync(path.join(root, 'src/components/Fresh.tsx'), 'export function Fresh() { return <div className="fresh-card">Yeni</div>; }\n');
  const post = { ...input, hook_event_name: 'PostToolUse', tool_response: {} };
  const shownFile = path.join(snapDir, 'shown.json');
  const { events, actions } = shellChangeEvents(post, undefined, { dir: snapDir, shownFile });
  const files = events.map((e) => path.basename(e.file));
  assert.ok(files.includes('TeamBoardContent.tsx') && files.includes('Other.tsx'), files.join(','));
  const board = events.filter((e) => e.file === boardFile);
  assert.ok(board.every((e) => e.phase === 'post'));
  assert.ok(board.some((e) => e.hint.classes.includes('board-row')), 'yalnızca komutun değişikliği (board-row)');
  assert.ok(!board.some((e) => e.hint.classes.includes('shadow')), 'komuttan önceki değişiklik tekrar gösterilmez');
  assert.ok(events.some((e) => e.created && path.basename(e.file) === 'Fresh.tsx' && e.next && e.next.classes.includes('fresh-card')));
  assert.ok(actions.some((a) => /Edited TeamBoardContent\.tsx \(\+1\/−1\)/.test(a.text)), actions.map((a) => a.text).join(' | '));
  assert.equal(shellChangeEvents(post, undefined, { dir: snapDir, shownFile }).events.length, 0);

  const input2 = { ...input, tool_use_id: 'toolu_test_2' };
  assert.equal(snapshotShell(input2, [path.join(root, 'src/components/Other.tsx')], { dir: snapDir }), true);
  const t2 = Date.now() / 1000 + 4;
  fs.writeFileSync(path.join(root, 'src/components/Other.tsx'), 'export function Other() { return <p className="other-note text-lg">Not</p>; }\n');
  fs.utimesSync(path.join(root, 'src/components/Other.tsx'), t2, t2);
  const r2 = shellChangeEvents({ ...input2, hook_event_name: 'PostToolUse' }, undefined, { dir: snapDir, shownFile });
  assert.equal(r2.events.filter((e) => path.basename(e.file) === 'Other.tsx').length, 0);
  assert.ok(r2.actions.some((a) => /Other\.tsx/.test(a.text)));

  const input3 = { ...input, tool_use_id: 'toolu_test_3' };
  assert.equal(snapshotShell(input3, [], { dir: snapDir }), true);
  const t3 = Date.now() / 1000 + 6;
  fs.writeFileSync(boardFile, fs.readFileSync(boardFile, 'utf8').replace('board-actions', 'board-actions gap-2'));
  fs.utimesSync(boardFile, t3, t3);
  noteShown([boardFile], { file: shownFile });
  const r3 = shellChangeEvents({ ...input3, hook_event_name: 'PostToolUse' }, undefined, { dir: snapDir, shownFile });
  assert.equal(r3.events.length, 0, JSON.stringify(r3.events.map((e) => e.file)));
});

test('bitişik satırlardaki ayrı değişiklikler ayrı imleç; mantık satırı bileşenin kök elemanına', () => {
  const file = path.join(os.tmpdir(), 'ac-hunks', 'TeamBoardContent.tsx');
  const split = BOARD.replace('<tbody><tr className="board-row">', '<tbody>\n        <tr className="board-row">');
  const splitAfter = split.replace('min-w-[960px]', 'min-w-[1120px]').replace('<tr className="board-row">', '<tr className="board-row hover:bg-subtle">');
  const evs = eventsFromHunks(file, split, splitAfter);
  assert.equal(evs.length, 2, JSON.stringify(evs.map((e) => e.hint)));

  const root = project(NEXT);
  const command = `cd "${slash(root)}" && python - <<'EOF'\np='src/components/dashboard/team/TeamBoardContent.tsx'\ns=open(p).read()\ns=s.replace('import { Coffee } from "@/components/icons";', 'import { Coffee, Users } from "@/components/icons";')\nopen(p,'w').write(s)\nEOF`;
  const out = planPreEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } });
  assert.equal(out.length, 1);
  assert.equal(out[0].anchor, 'component');
  assert.ok(out[0].hint.classes.includes('team-board'), JSON.stringify(out[0].hint));
});

test('test dosyaları imleç almaz; yol proje köküne göre bakılır', () => {
  const root = project({ ...NEXT, '.agent-cursors/routes.json': '{}', 'test/board.test.mjs': 'const html = \'<tr className="board-row">\';\n' }, 'ac-tests-');
  assert.equal(isTestFile(path.join(root, 'test', 'board.test.mjs')), true);
  assert.equal(isTestFile(path.join(root, 'src', 'components', 'A.spec.tsx')), true);
  assert.equal(isTestFile(path.join(root, 'src', 'components', 'dashboard', 'team', 'TeamBoardContent.tsx')), false);
  const nested = project({ 'test/app/.agent-cursors/routes.json': '{}', 'test/app/src/A.tsx': 'export const A = () => <div className="a-card">A</div>;\n' }, 'ac-nested-');
  assert.equal(isTestFile(path.join(nested, 'test', 'app', 'src', 'A.tsx')), false);
  const evs = buildEvents({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: path.join(root, 'test', 'board.test.mjs'), old_string: 'board-row', new_string: 'board-row is-live' } });
  assert.equal(evs.length, 0);
});
