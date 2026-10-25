// A small square castle from library components. Dry run by default:
//   node examples/castle.mjs                                  # counts per material + bounding box
//   node examples/castle.mjs --size=26 --towerRoof=flat --palette=deepslate
//   node examples/castle.mjs --build --anchor=4,1,4           # place it (needs the ticket env vars)
import { castle, palette, build, cliOptions } from '../lib/index.mjs';

const { params, ...run } = cliOptions();
const { palette: pal = 'stoneCastle', ...rest } = params;
const plan = castle({ size: 18, towerRadius: 3, towerHeight: 10, wallHeight: 7, wallThickness: 3, ...rest, palette: palette(pal) });
await build(plan, { label: 'castle', ...run, anchor: run.anchor || [0, 1, 0] });
