// The job handler modules the runtime's pool loads (main.ts). A later phase adds its module here (docs/37 P3: aim,
// raycast, los; P4: path; P6: findBlocks); each one runs in every reader worker and, inline, on the main thread.

export const STOCK_HANDLERS: URL[] = [new URL('./echo.mjs', import.meta.url)];
// P6: mineflayer's findBlocks over the shared world (mineBlock's search, api/block-search.ts).
STOCK_HANDLERS.push(new URL('./find-blocks.mjs', import.meta.url));
// docs/37 P3: one aim update of a drawing archer (aim/solve.mjs), submitted by aim/draw.ts.
STOCK_HANDLERS.push(new URL('./aim.mjs', import.meta.url));
STOCK_HANDLERS.push(new URL('./path.mjs', import.meta.url)); // P4: A* (docs/37), bots/pathworkers/offload.ts submits it
