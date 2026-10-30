// Sets up a standalone Fabric server for this mod, like the production one (PaulsBrawlsVanilla), from a clone:
//   the Fabric server launcher for the Minecraft and loader versions in gradle.properties (it downloads Mojang's
//   server jar and the libraries itself on first start: Mojang's jar may not be redistributed, so it is not in git),
//   Fabric API, the mod built from this checkout, the production server's extra mods (pinned, hash-checked),
//   the runtime files the mod reads from its working directory, and start scripts.
//
//   node scripts/setup-server.mjs                        # into server/ (gitignored)
//   node scripts/setup-server.mjs D:/mc/brawls           # anywhere else
//   node scripts/setup-server.mjs --accept-eula          # also write eula.txt (you accept Mojang's EULA:
//                                                        #   https://aka.ms/MinecraftEULA)
//   --no-extras      only Fabric API and the mod        --skip-build   reuse build/libs instead of building
//   --memory=6G      the start scripts' -Xmx (4G)
// Re-running updates jars and keeps everything else (worlds, configs, server.properties, edited prompts).
// After an EULA stop the window stays open: WorldEdit's session timer is a non-daemon thread. Close it and restart.
//
// The dev server is a different thing: ./gradlew runServer runs the mod from source in run/ (Loom fetches the
// server there), so run/ has no jar. Never copy this server's mods into run/mods: a second Fabric API or a built
// copy of the mod next to Loom's classpath crashes the dev server.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = (name, dflt) => argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const DIR = resolve(argv.find(a => !a.startsWith('--')) ?? join(ROOT, 'server'));
const MEMORY = opt('memory', '4G');

/** The installer version the launcher is built with (meta.fabricmc.net/v2/versions/installer). */
const FABRIC_INSTALLER = '1.1.2';
/**
 * The production server's other mods, pinned to the versions it runs (Modrinth CDN; the SHA-512 is Modrinth's, and
 * equals the production jars'). `prefix` finds an older version of the same mod to replace. Universal Shops was
 * removed on 2026-10-27: its Polymer items make mineflayer's decoder fail, which leaves every Squad bot deaf
 * (docs/29 §16).
 */
const EXTRAS = [
    { file: 'worldedit-mod-7.3.8.jar', prefix: 'worldedit-mod-', url: 'https://cdn.modrinth.com/data/1u6JkXh5/versions/WTAFvuRx/worldedit-mod-7.3.8.jar',
        sha512: 'e039492df0b486e7ce76d0eaf8cb11eadad2e78220600b8498ab8eef4642a29e310a6bcb4378257553b3639c6d0bc1ebf0f73df3a7a677c6af6baf86716b0bc7' },
    { file: 'voicechat-fabric-1.21.1-2.5.33.jar', prefix: 'voicechat-fabric-', url: 'https://cdn.modrinth.com/data/9eGKb6K1/versions/7NHvY1SY/voicechat-fabric-1.21.1-2.5.33.jar',
        sha512: '514c442a1034f292220c9d2ea20ed4ec6a2d8468d33a6232e733bf5f8d868528a29b61af2f7c0cfcf81ea02ff44868b25af4061cba3feb66ee11a4b90c481a10' },
];
/** What the mod reads from its working directory, copied in when missing (never overwritten). */
const RUNTIME_FILES = ['run/prompt.txt', 'run/build_prompt.txt', 'run/mcp_config.properties'];

const props = Object.fromEntries(readFileSync(join(ROOT, 'gradle.properties'), 'utf8').split(/\r?\n/)
    .filter(l => /^[a-z_]+=/i.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const MC = props.minecraft_version, LOADER = props.loader_version, FAPI = props.fabric_version;
const MOD_JAR = `${props.archives_base_name}-${props.mod_version}.jar`;
const log = (...a) => console.log(...a);
const sha = (algo, buf) => createHash(algo).update(buf).digest('hex');

async function fetchBytes(url) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'pauls-brawls setup-server' } });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** Downloads `url` to `path` unless a file with the expected SHA-512 is already there; refuses a hash mismatch. */
async function download(url, path, sha512) {
    if (sha512 && existsSync(path) && sha('sha512', readFileSync(path)) === sha512) { log(`  ok      ${path}`); return; }
    const buf = await fetchBytes(url);
    if (sha512 && sha('sha512', buf) !== sha512) throw new Error(`${url}: SHA-512 mismatch (expected ${sha512.slice(0, 16)}…, got ${sha('sha512', buf).slice(0, 16)}…)`);
    writeFileSync(path, buf);
    log(`  fetched ${path} (${(buf.length / 1e6).toFixed(1)} MB${sha512 ? ', SHA-512 ok' : ''})`);
}

/** Removes the other versions of a jar (same name before the version) from mods/, so an update never leaves two. */
function dropOtherVersions(mods, keep, prefix) {
    for (const f of readdirSync(mods)) if (f !== keep && f.startsWith(prefix) && f.endsWith('.jar')) { rmSync(join(mods, f)); log(`  removed ${join(mods, f)}`); }
}

log(`Setting up a Fabric ${MC} server (loader ${LOADER}, Fabric API ${FAPI}) in ${DIR}`);
const MODS = join(DIR, 'mods');
mkdirSync(MODS, { recursive: true });

// 1. The Fabric server launcher (no published hash: it is generated per version by the official meta server).
await download(`https://meta.fabricmc.net/v2/versions/loader/${MC}/${LOADER}/${FABRIC_INSTALLER}/server/jar`, join(DIR, 'fabric-server-launch.jar'));

// 2. Fabric API, checked against the SHA-512 the Fabric Maven publishes next to it.
const fapiFile = `fabric-api-${FAPI}.jar`, fapiUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${FAPI}/${fapiFile}`;
const fapiSha = (await fetchBytes(`${fapiUrl}.sha512`)).toString('utf8').trim().split(/\s+/)[0];
dropOtherVersions(MODS, fapiFile, 'fabric-api-');
await download(fapiUrl, join(MODS, fapiFile), fapiSha);

// 3. The production server's other mods.
if (!flag('no-extras')) {
    for (const m of EXTRAS) {
        dropOtherVersions(MODS, m.file, m.prefix);
        await download(m.url, join(MODS, m.file), m.sha512);
    }
}

// 4. The mod, built from this checkout. remapJar, not build: build's finalizers copy the jar into the mods_folder
//    paths in gradle.properties (Paul's machines).
if (!flag('skip-build')) {
    log('  building the mod (gradlew remapJar)…');
    // An absolute path: with NoDefaultCurrentDirectoryInExePath set, cmd does not look in the current directory.
    const win = process.platform === 'win32';
    execFileSync(win ? 'cmd.exe' : join(ROOT, 'gradlew'), [...(win ? ['/c', join(ROOT, 'gradlew.bat')] : []), 'remapJar', '--console=plain', '-q'], { cwd: ROOT, stdio: 'inherit' });
}
const built = join(ROOT, 'build', 'libs', MOD_JAR);
if (!existsSync(built)) throw new Error(`${built} not found: build the mod (./gradlew remapJar) or drop --skip-build`);
dropOtherVersions(MODS, MOD_JAR, `${props.archives_base_name}-`);
cpSync(built, join(MODS, MOD_JAR));
log(`  copied  ${join(MODS, MOD_JAR)}`);

// 5. Runtime files and the external agent's config (god-agent/README.md, step 2), when missing.
for (const rel of RUNTIME_FILES) {
    const to = join(DIR, rel.replace(/^run\//, ''));
    if (!existsSync(to)) { cpSync(join(ROOT, rel), to); log(`  copied  ${to}`); }
}
// server.properties from the dev server's (online-mode=false: the Mineflayer bots log in offline; spawn-protection
// 0, op level 4), on the production port, RCON off: run/'s RCON password is public in this repo.
const serverProps = join(DIR, 'server.properties');
if (!existsSync(serverProps)) {
    const p = readFileSync(join(ROOT, 'run', 'server.properties'), 'utf8').replace(/^#.*\r?\n/gm, '')
        .replace(/^server-port=.*$/m, 'server-port=25565').replace(/^enable-rcon=.*$/m, 'enable-rcon=false').replace(/^rcon\.password=.*$/m, 'rcon.password=');
    writeFileSync(serverProps, `#From run/server.properties by scripts/setup-server.mjs (port 25565, RCON off)\n${p}`);
    log(`  wrote   ${serverProps}`);
}
const agentDir = join(DIR, 'god-agent', 'claude-code');
if (!existsSync(agentDir)) { cpSync(join(ROOT, 'god-agent', 'claude-code'), agentDir, { recursive: true }); log(`  copied  ${agentDir}`); }

// 6. EULA (only on request: accepting it is the server owner's call) and start scripts.
const eula = join(DIR, 'eula.txt');
if (flag('accept-eula')) writeFileSync(eula, `# Accepted with setup-server.mjs --accept-eula (https://aka.ms/MinecraftEULA)\neula=true\n`);
writeFileSync(join(DIR, 'start.bat'), `@echo off\r\ncd /d "%~dp0"\r\njava -Xmx${MEMORY} -jar fabric-server-launch.jar nogui\r\npause\r\n`);
writeFileSync(join(DIR, 'start.sh'), `#!/bin/sh\ncd "$(dirname "$0")"\nexec java -Xmx${MEMORY} -jar fabric-server-launch.jar nogui\n`);
try { chmodSync(join(DIR, 'start.sh'), 0o755); } catch { /* Windows */ }

log(`\nDone. Start it with ${join(DIR, process.platform === 'win32' ? 'start.bat' : 'start.sh')}.`);
if (!existsSync(eula) || !/eula=true/.test(readFileSync(eula, 'utf8'))) {
    log('The first start stops at the EULA: read https://aka.ms/MinecraftEULA, set eula=true in eula.txt (or re-run with --accept-eula), start again.');
}
log('The first start also downloads the Minecraft server and its libraries. Port 25565 (server.properties), 8767 (village');
log('settlement, village_config.properties) and 24454/udp (voice chat) must be free: only one of these servers per machine.');
log('API keys stay in the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY); external God mode: god-agent/README.md.');
