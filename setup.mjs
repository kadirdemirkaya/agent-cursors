import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const uninstall = process.argv.includes('--uninstall');
const port = Number(process.env.AGENT_CURSORS_PORT) || 7373;
const extDir = path.join(dir, 'extension');

const r = spawnSync(process.execPath, [path.join(dir, 'install.mjs'), os.homedir(), ...(uninstall ? ['--uninstall'] : [])], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
if (r.status !== 0) {
  process.stderr.write(r.stderr || '');
  process.exit(r.status || 1);
}
if (uninstall) process.exit(0);

const getHealth = () => new Promise((res) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (x) => {
    let buf = '';
    x.setEncoding('utf8');
    x.on('data', (c) => (buf += c));
    x.on('end', () => { try { res(x.statusCode === 200 ? JSON.parse(buf) : null); } catch { res(null); } });
  });
  q.on('error', () => res(null)); q.on('timeout', () => { q.destroy(); res(null); });
});
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

function killOnPort(p) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = new RegExp(`127\\.0\\.0\\.1:${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(line);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
      return pids.size > 0;
    }
    let pids = (spawnSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '').split(/\s+/).filter(Boolean);
    if (!pids.length) {
      const ss = spawnSync('ss', ['-ltnpH', `sport = :${p}`], { encoding: 'utf8' }).stdout || '';
      pids = [...ss.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
    }
    for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
    return pids.length > 0;
  } catch { return false; }
}

let h = await getHealth();
if (h && !(h.protocol >= 4)) {
  console.log('• Eski sürüm daemon bulundu; yenisiyle değiştiriliyor...');
  killOnPort(port);
  for (let i = 0; i < 10 && (await getHealth()); i++) await sleep(150);
  h = await getHealth();
  if (h && !(h.protocol >= 4)) console.log(`  ! Eski daemon kapatılamadı. ${port} portunu kullanan node sürecini elle kapatıp setup'ı tekrar çalıştırın.`);
}

let up = !!h;
if (!up) {
  const c = spawn(process.execPath, [path.join(dir, 'daemon.mjs')], { detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {}); c.unref();
  for (let i = 0; i < 10 && !up; i++) { await sleep(150); up = !!(await getHealth()); }
}
console.log(up ? `✓ Daemon çalışıyor (127.0.0.1:${port})` : `✗ Daemon başlatılamadı: ${port} portu başka bir program tarafından kullanılıyor olabilir.`);

for (const [cmd, args] of [['pbcopy', []], ['clip', []], ['xclip', ['-selection', 'clipboard']]]) {
  const p = spawnSync(cmd, args, { input: extDir, stdio: ['pipe', 'ignore', 'ignore'] });
  if (!p.error && p.status === 0) { console.log('✓ Eklenti klasörünün yolu panoya kopyalandı'); break; }
}

console.log(`
Hook'lar (Claude Code ve Codex) düzenleme UYGULANMADAN ÖNCE çalışır: imleç elemana varıp animasyonunu bitirene kadar
ajan ~2,2-2,8 sn bekler (üst sınır 5 sn), sonra değişiklik çizilen alana yansır. Bekletmeyi kapatmak için: AGENT_CURSORS_HOLD_MS=0
Codex'te matcher "*" olan PreToolUse/PostToolUse hook'larını /hooks veya Settings → Hooks bölümünden gözden geçirip güvenilir işaretleyin.
Claude Code'da matcher dosya araçlarını, Bash/PowerShell yazmalarını, MCP yazma araçlarını ve plan güncellemelerini kapsar; PostToolUse ayrıca Read'i (okuma imleci) kapsar.
Yalnızca arayüz kaynak dosyalarındaki değişiklikler imleç üretir.
Şimdi sadece Chrome'a eklentiyi yükleyin (bir kez):
  1. Chrome'da  chrome://extensions  açın
  2. Sağ üstten "Geliştirici modu"nu açın
  3. "Paketlenmemiş öğe yükle" → şu klasörü seçin:
       ${extDir}
  4. Eklentiyi daha önce yüklediyseniz chrome://extensions sayfasında Ajan İmleçleri'ndeki ↻ (yenile) düğmesine basın
  5. Claude Code ve/veya Codex'i kapatıp yeniden açın (Codex hook'unu önceden güvenilir işaretleyin)

Bitti: herhangi bir projede dev sunucuyu açıp Claude Code veya Codex'le çalışın; imleçler kendiliğinden gelir.
Bu klasörü silmeyin veya taşımayın (taşırsanız setup'ı yeniden çalıştırın).
`);
process.exit(up ? 0 : 1);
