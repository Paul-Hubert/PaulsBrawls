import os from 'os';
import path from 'path';
import { dot, EmbeddingService } from '../src/village/embeddings.js';
import type { VillageSettings } from '../src/village/types.js';

const settings: VillageSettings = {
  llm: { provider: 'openai', baseUrl: '', model: 'x', fastModel: '', apiKey: '', timeoutMs: 60_000, temperature: 0, maxTokens: 10 },
  embeddings: { mode: 'local', model: '' }, // '' → the production default model
  dayPlanning: false,
  needs: { restDecayPerMin: 0, restRecoverPerMin: 0, socialDecayPerMin: 0, socialRecoverPerMin: 0, lowThreshold: 0.25 },
  spontaneousChat: false,
  concurrency: 1,
  heartbeatSeconds: 1,
  botCooldownMs: 0,
  earshotRadius: 32,
  settlementUrl: '',
  dataDir: path.join(os.tmpdir(), 'emb-smoke'),
  maxConversationTurns: 8,
};

const svc = new EmbeddingService(settings);
const t0 = Date.now();
const a = await svc.embedQuery('je cherche des légumes pour le ragoût');
const tFirst = Date.now() - t0;
const b = await svc.embedQuery('belle récolte de carottes au potager');
const c = await svc.embedQuery('le zombie attaque le garde au crépuscule');
if (!a || !b || !c) {
  console.log('FAIL: embedQuery returned null (service disabled?)');
  process.exit(1);
}
console.log(`dims=${a.length} first-query(init+download)=${tFirst}ms total=${Date.now() - t0}ms`);
console.log(`veg~harvest cosine = ${dot(a, b).toFixed(3)} (want high)`);
console.log(`veg~zombie  cosine = ${dot(a, c).toFixed(3)} (want low)`);
process.exit(0);
