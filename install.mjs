import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook.mjs').replace(/\\/g, '/');

const MATCHER = 'Edit|Write|MultiEdit|Bash|PowerShell|TodoWrite|TaskCreate|TaskUpdate|mcp__.*';
const POST_MATCHER = MATCHER + '|Read';
const COMMAND = `node "${HOOK_PATH}"`;
const CODEX_MATCHER = '*';
const SCRIPT_TAG = '<script src="http://127.0.0.1:7373/overlay.js"></script>';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    html: { type: 'string' },
    uninstall: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log('Kullanım: node install.mjs <proje-dizini> [--html index.html] [--uninstall]');
  process.exit(values.help ? 0 : 2);
}

const projectDir = path.resolve(positionals[0]);
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`Dizin bulunamadı: ${projectDir}`);
  process.exit(1);
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(HOOK_PATH);

const CLAUDE_HOOKS = {
  PreToolUse: { timeout: 8 },
  PostToolUse: { timeout: 3, matcher: POST_MATCHER },
};
const CODEX_HOOKS = {
  PreToolUse: { timeout: 6 },
  PostToolUse: { timeout: 3 },
};

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch {
    console.error(`${file} geçerli JSON değil; dokunulmadı. Elle düzeltip tekrar deneyin.`);
    process.exit(1);
  }
}

function stripOurs(list) {
  let removed = 0;
  const next = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    const kept = hooks.filter((h) => !isOurs(h));
    removed += hooks.length - kept.length;
    if (kept.length) next.push({ ...entry, hooks: kept });
  }
  return { next, removed };
}

function patchHookFile(file, label, matcher, events) {
  const settings = readJson(file);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

  if (values.uninstall) {
    let removed = 0;
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const r = stripOurs(settings.hooks[event]);
      removed += r.removed;
      if (r.next.length) settings.hooks[event] = r.next;
      else delete settings.hooks[event];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    if (removed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    console.log(removed ? `✓ ${label} hook kaldırıldı: ${file}` : `• Kaldırılacak ${label} hook bulunamadı.`);
    return;
  }

  for (const [event, opts] of Object.entries(events)) {
    const r = stripOurs(settings.hooks[event]);
    r.next.push({ matcher: opts.matcher || matcher, hooks: [{ type: 'command', command: COMMAND, timeout: opts.timeout }] });
    settings.hooks[event] = r.next;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ ${label} PreToolUse + PostToolUse hook eklendi: ${file}`);
  console.log(`  komut: ${COMMAND}`);
}

const patchSettings = () => patchHookFile(path.join(projectDir, '.claude', 'settings.json'), 'Claude Code', MATCHER, CLAUDE_HOOKS);
const patchCodexSettings = () => patchHookFile(path.join(projectDir, '.codex', 'hooks.json'), 'Codex', CODEX_MATCHER, CODEX_HOOKS);

function patchHtml() {
  const file = path.resolve(projectDir, values.html);
  if (!fs.existsSync(file)) {
    console.error(`HTML dosyası bulunamadı: ${file}`);
    process.exit(1);
  }
  let html = fs.readFileSync(file, 'utf8');
  const has = /127\.0\.0\.1:7373\/overlay\.js/.test(html);
  if (values.uninstall) {
    if (!has) return console.log('• HTML içinde script etiketi yok.');
    html = html.replace(/[ \t]*<script[^>]*127\.0\.0\.1:7373\/overlay\.js[^>]*><\/script>[ \t]*\r?\n?/g, '');
    fs.writeFileSync(file, html);
    return console.log(`✓ Script etiketi kaldırıldı: ${file}`);
  }
  if (has) return console.log(`• Script etiketi zaten var: ${file}`);
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `  ${SCRIPT_TAG}\n</body>`);
  else if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `  ${SCRIPT_TAG}\n</head>`);
  else html += `\n${SCRIPT_TAG}\n`;
  fs.writeFileSync(file, html);
  console.log(`✓ Script etiketi eklendi: ${file}`);
  console.log('  Not: yalnızca geliştirme içindir; yayına çıkmadan önce kaldırın.');
}

patchSettings();
patchCodexSettings();
if (values.html) patchHtml();
if (!values.uninstall) console.log('Sonraki adım: Claude Code/Codex oturumunu yeniden başlatın; Codex hook’unu güvenilir işaretleyin. Daemon ilk düzenlemede otomatik başlar.');
