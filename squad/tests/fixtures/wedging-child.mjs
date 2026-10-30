// A fake runtime for the supervisor test: counts its launches, beats for a moment, then wedges its event loop.
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.SQUAD_TEST_COUNTER, 'start\n');
const beat = setInterval(() => process.send?.({ type: 'heartbeat' }), 100);
process.on('message', (m) => {
  if (m?.type === 'shutdown') process.exit(0);
});
setTimeout(() => {
  clearInterval(beat);
  for (;;) { /* a wedged event loop: no heartbeat ever again */ }
}, 400);
