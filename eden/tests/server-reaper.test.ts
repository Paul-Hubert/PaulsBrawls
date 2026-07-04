// B1 logic-tier tests for the reaper's PURE logic (docs/26 B1 DoD): netstat parsing, port→PID
// resolution + dedupe (25599+8767 are the same server JVM), and the production-port refusal.
// The exec wrappers (netstat/taskkill) are exercised by the lifecycle smoke, not here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CI_PORTS, PRODUCTION_PORT, ownersOf, parseListeners } from '../live-tests/server/reaper';

// A representative Windows `netstat -ano` slice: IPv4 + IPv6 listeners, established rows, UDP rows.
const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:8767           0.0.0.0:0              LISTENING       4321',
  '  TCP    0.0.0.0:25599          0.0.0.0:0              LISTENING       4321',
  '  TCP    0.0.0.0:25575          0.0.0.0:0              LISTENING       4321',
  '  TCP    127.0.0.1:8770         0.0.0.0:0              LISTENING       9876',
  '  TCP    0.0.0.0:25565          0.0.0.0:0              LISTENING       1111',
  '  TCP    192.168.1.5:52344      13.107.42.14:443       ESTABLISHED     2222',
  '  TCP    [::]:25599             [::]:0                 LISTENING       4321',
  '  TCP    [::1]:8770             [::]:0                 LISTENING       9876',
  '  UDP    0.0.0.0:5353           *:*                                    3333',
].join('\r\n');

describe('reaper logic (B1 / P-15)', () => {
  it('parseListeners: TCP LISTENING rows only, IPv4 + IPv6, ports + PIDs numeric', () => {
    const listeners = parseListeners(NETSTAT);
    assert.deepEqual(
      listeners.map((l) => `${l.port}:${l.pid}`),
      ['8767:4321', '25599:4321', '25575:4321', '8770:9876', '25565:1111', '25599:4321', '8770:9876'],
    );
  });

  it('ownersOf dedupes PIDs across ports and address families (25599+25575+8767 = ONE server JVM)', () => {
    const owners = ownersOf(CI_PORTS, parseListeners(NETSTAT));
    assert.deepEqual([...owners.keys()].sort(), [4321, 9876]);
    assert.deepEqual(owners.get(4321)!.sort((a, b) => a - b), [8767, 25575, 25599]);
    assert.deepEqual(owners.get(9876), [8770]);
  });

  it('an absent listener is success, not error (empty netstat → empty owners)', () => {
    assert.equal(ownersOf(CI_PORTS, parseListeners('Active Connections\n')).size, 0);
  });

  it('REFUSES to resolve owners of the production port 25565 — even though a listener exists', () => {
    assert.throws(() => ownersOf([PRODUCTION_PORT], parseListeners(NETSTAT)), /production/);
    assert.throws(() => ownersOf([...CI_PORTS, PRODUCTION_PORT], parseListeners(NETSTAT)), /production/);
    // and the production listener never leaks into a legitimate resolution:
    const owners = ownersOf(CI_PORTS, parseListeners(NETSTAT));
    assert.ok(!owners.has(1111), 'PID 1111 (production) must not appear');
  });
});
