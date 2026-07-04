// B1 logic-tier tests for the D-17 properties overlay (docs/26 B1 DoD): full-file rewrite, the
// Properties colon-escaping, the stamp, backup/restore, and leftover-backup healing. Pure text +
// tmp-dir fs — no server anywhere near this.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BACKUP_STAMP,
  CI_OVERRIDES,
  backupAndOverlay,
  backupPathOf,
  buildOverlay,
  healLeftoverBackup,
  parseProperties,
  restoreFromBackup,
  serializeProperties,
  stampBackup,
  unstampBackup,
} from '../live-tests/server/properties-overlay';

const DEV_PROPS = [
  '#Minecraft server properties',
  '#Thu Jun 18 18:32:43 CEST 2026',
  'enable-rcon=true',
  'level-name=world',
  'level-seed=',
  'level-type=minecraft\\:normal',
  'max-tick-time=60000',
  'motd=A Minecraft Server',
  'rcon.password=hunter2',
  'rcon.port=25575',
  'server-port=25599',
  'spawn-protection=0',
].join('\r\n') + '\r\n';

describe('properties overlay (D-17)', () => {
  it('parse round-trips keys and keeps values RAW (escapes intact)', () => {
    const props = parseProperties(DEV_PROPS);
    assert.equal(props.get('level-type'), 'minecraft\\:normal');
    assert.equal(props.get('level-seed'), '');
    assert.equal(props.get('rcon.password'), 'hunter2');
  });

  it('buildOverlay is a FULL-FILE rewrite: every original key carried, overrides applied on top', () => {
    const out = buildOverlay(DEV_PROPS);
    const props = parseProperties(out);
    // Overrides landed…
    assert.equal(props.get('level-name'), 'eden-ci');
    assert.equal(props.get('level-seed'), CI_OVERRIDES['level-seed']);
    assert.equal(props.get('difficulty'), 'peaceful');
    // …with the Properties colon-escape emitted LITERALLY (P-20 — a malformed value silently
    // regenerates a NORMAL world):
    assert.ok(out.includes('level-type=minecraft\\:flat'), `overlay must escape the colon — got:\n${out}`);
    // …and every non-overridden original key carried over verbatim.
    assert.equal(props.get('max-tick-time'), '60000');
    assert.equal(props.get('motd'), 'A Minecraft Server');
    assert.equal(props.get('rcon.password'), 'hunter2');
    assert.equal(props.get('server-port'), '25599');
  });

  it('overlay output is LF-normalized with a trailing newline', () => {
    const out = buildOverlay(DEV_PROPS);
    assert.ok(!out.includes('\r'), 'no CR anywhere');
    assert.ok(out.endsWith('\n'));
  });

  it('buildOverlay refuses a file with no rcon.password (the ready-gate would hang instead)', () => {
    const noRcon = DEV_PROPS.replace('rcon.password=hunter2', 'rcon.password=');
    assert.throws(() => buildOverlay(noRcon), /rcon\.password/);
  });

  it('stamp round-trip: unstampBackup(stampBackup(x)) === x; a foreign file yields null', () => {
    assert.equal(unstampBackup(stampBackup(DEV_PROPS)), DEV_PROPS);
    assert.equal(unstampBackup(DEV_PROPS), null);
    assert.equal(unstampBackup('# some other header\n' + DEV_PROPS), null);
  });

  describe('fs wrappers (tmp dir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eden-overlay-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('backupAndOverlay → restoreFromBackup is byte-identical (restore-to-backup, never restore-to-HEAD)', () => {
      const propsPath = join(dir, 'server.properties');
      writeFileSync(propsPath, DEV_PROPS, 'utf8');
      backupAndOverlay(propsPath);
      assert.ok(readFileSync(propsPath, 'utf8').includes('level-name=eden-ci'), 'overlay applied');
      assert.ok(readFileSync(backupPathOf(propsPath), 'utf8').startsWith(BACKUP_STAMP), 'backup stamped');
      restoreFromBackup(propsPath);
      assert.equal(readFileSync(propsPath, 'utf8'), DEV_PROPS, 'the LOCALLY-DIRTY working-tree bytes come back exactly');
      assert.ok(!existsSync(backupPathOf(propsPath)), 'backup removed after restore');
    });

    it('healLeftoverBackup restores a stamped leftover and reports it; no-op when absent', () => {
      const propsPath = join(dir, 'crashed.properties');
      writeFileSync(propsPath, buildOverlay(DEV_PROPS), 'utf8'); // a crashed run left the overlay live
      writeFileSync(backupPathOf(propsPath), stampBackup(DEV_PROPS), 'utf8');
      assert.equal(healLeftoverBackup(propsPath), 'healed');
      assert.equal(readFileSync(propsPath, 'utf8'), DEV_PROPS);
      assert.ok(!existsSync(backupPathOf(propsPath)));
      assert.equal(healLeftoverBackup(propsPath), 'none');
    });

    it('healLeftoverBackup REFUSES an unstamped (foreign) backup file', () => {
      const propsPath = join(dir, 'foreign.properties');
      writeFileSync(propsPath, DEV_PROPS, 'utf8');
      writeFileSync(backupPathOf(propsPath), 'not a stamped backup\n', 'utf8');
      assert.throws(() => healLeftoverBackup(propsPath), /foreign file/);
      // and restore refuses it too
      assert.throws(() => restoreFromBackup(propsPath), /not a stamped CI backup/);
    });
  });

  it('serializeProperties emits key=value lines only (plus comment header)', () => {
    const out = serializeProperties(new Map([['a', '1'], ['b', 'x\\:y']]));
    assert.ok(out.includes('a=1\n'));
    assert.ok(out.includes('b=x\\:y\n'));
  });
});
