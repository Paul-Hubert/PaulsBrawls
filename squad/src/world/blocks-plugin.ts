// mineflayer's blocks plugin (mineflayer/lib/plugins/blocks.js, 4.39) for a bot that reads the shared world
// (world.shared, docs/37 P5). createBot's `plugins: { blocks: … }` replaces mineflayer's own (bots/pool.ts), so no bot
// parses a chunk: SharedWorld forwards each column once to the writer thread, and `bot.world` is the bot's
// SharedBotWorld over the store (bot-world.ts). The API is mineflayer's, function for function:
//   • bot.blockAt, bot.findBlocks, bot.findBlock, bot.canSeeBlock, bot.waitForChunksToLoad, bot._updateBlockState
//     (digging's prediction), bot.updateSign, bot._getDimensionName; the events blockUpdate, blockUpdate:(x, y, z),
//     chunkColumnLoad and chunkColumnUnload (forwarded from bot.world, as mineflayer's listener proxy does),
//     blockEntityData, signOpen; paintings; the chunk batches' acknowledgements (the server waits for them).
//   • findBlocks with block ids (a number or an array, what Squad's helpers pass) is the store's search
//     (world/find-blocks.mjs): mineflayer's answer, position for position, over the columns this bot holds, in a
//     fraction of the time (0.1 ms against 15 ms for gather's search, docs/37 §10.4). It reads the store, which shows
//     a block change a few ms after the bot heard it (the bot's overlay is not searched); every caller checks a
//     found block with blockAt. A matcher function (or a useExtraInfo function) takes mineflayer's own walk over
//     blockAt, with a section's states standing in for its palette.
//   • Not ported: map_chunk_bulk (before 1.9), update_light (light is not stored), update_sign from the server
//     (before 1.10: 1.21 sends block entities).
// If the shared world cannot take the bot (no packet stream, stopped), the bot gets mineflayer's own plugin.

import { createRequire } from 'node:module';

import { Vec3 } from 'vec3';

import { findBlocksIn, matchKey, matchTable } from './find-blocks.mjs';
import type { BlockLike } from './blocks.mjs';
import type { SharedBotWorld } from './bot-world';

const require = createRequire(import.meta.url);
const ownBlocks = require('mineflayer/lib/plugins/blocks') as MineflayerPlugin;
const Painting = require('mineflayer/lib/painting') as new (id: number, pos: Vec3, title: unknown, face: Vec3) => { id: number; position: Vec3 };
const { onceWithCleanup } = require('mineflayer/lib/promise_utils') as { onceWithCleanup: (em: unknown, ev: string, o: { timeout: number }) => Promise<unknown> };
const { OctahedronIterator } = require('prismarine-world').iterators as {
  OctahedronIterator: new (start: Vec3, apothem: number) => { apothem: number; next(): Vec3 | null };
};

export type MineflayerPlugin = (bot: unknown, options: Record<string, unknown>) => void;

/** What the plugin needs of the shared world. */
export interface SharedBlocksHost {
  bindView(bot: unknown): SharedBotWorld | null;
}

/** Match tables of the block-id searches, by query (a few: the helpers search by name). */
const MATCH_CACHE_SIZE = 32;
const matchCache = new Map<string, Uint8Array>();

const paintingFaceToVec = [new Vec3(0, 0, -1), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(1, 0, 0)];

type Bot = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- mineflayer's bot, as its plugins see it
type Matcher = (block: BlockLike | null) => boolean;

/** The plugin, given the shared world: one bot's blocks (SharedWorld.blocksPlugin() binds the world). */
export function injectSharedBlocks(botArg: unknown, options: Record<string, unknown>, host: SharedBlocksHost): void {
  const view = host.bindView(botArg);
  if (!view) {
    ownBlocks(botArg, options);
    return;
  }
  const bot = botArg as Bot;
  const world = view;
  bot.world = world;

  // -- the listener proxy (mineflayer's startListenerProxy) -----------------------------------------------------------
  for (const event of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']) {
    world.on(event, (...args: unknown[]) => bot.emit(event, ...args));
  }
  const blockUpdateRegex = /blockUpdate:\(-?\d+, -?\d+, -?\d+\)/;
  bot.on('newListener', (event: string, listener: (...a: unknown[]) => void) => {
    if (blockUpdateRegex.test(event)) world.on(event, listener);
  });
  bot.on('removeListener', (event: string, listener: (...a: unknown[]) => void) => {
    if (blockUpdateRegex.test(event)) world.off(event, listener);
  });
  // A change of dimension (switchWorld): every blockUpdate:(…) waiter hears (null, null) and is dropped.
  world.onSwitch = () => {
    for (const [name, listener] of Object.entries(bot._events as Record<string, unknown>)) {
      if (name.startsWith('blockUpdate:') && typeof listener === 'function') {
        bot.emit(name, null, null);
        bot.off(name, listener);
      }
    }
  };

  // -- paintings ------------------------------------------------------------------------------------------------------
  const paintingsByPos: Record<string, { id: number; position: Vec3 }> = {};
  const paintingsById: Record<number, { id: number; position: Vec3 }> = {};
  let paintings = 0;
  const addPainting = (p: { id: number; position: Vec3 }): void => {
    if (!paintingsById[p.id]) paintings++;
    paintingsById[p.id] = p;
    paintingsByPos[String(p.position)] = p;
  };
  const deletePainting = (p: { id: number; position: Vec3 }): void => {
    if (paintingsById[p.id]) paintings--;
    delete paintingsById[p.id];
    delete paintingsByPos[String(p.position)];
  };
  bot._client.on('spawn_entity_painting', (packet: Bot) => {
    const pos = new Vec3(packet.location.x, packet.location.y, packet.location.z);
    addPainting(new Painting(packet.entityId, pos, packet.title, paintingFaceToVec[packet.direction] as Vec3));
  });
  bot._client.on('entity_destroy', (packet: { entityIds: number[] }) => {
    if (paintings === 0) return;
    for (const id of packet.entityIds) {
      const p = paintingsById[id];
      if (p) deletePainting(p);
    }
  });
  // A block that changes type takes its painting with it (mineflayer's updateBlockState).
  world.on('blockUpdate', (oldBlock: BlockLike, newBlock: BlockLike) => {
    if (paintings === 0 || !oldBlock || !newBlock || oldBlock.type === newBlock.type) return;
    const p = paintingsByPos[String(newBlock.position)];
    if (p) deletePainting(p);
  });

  // -- reads ----------------------------------------------------------------------------------------------------------
  function blockAt(absolutePoint: Vec3, extraInfos = true): BlockLike | null {
    const block = world.getBlock(absolutePoint);
    // null block means chunk not loaded
    if (!block) return null;
    if (extraInfos && paintings > 0) block.painting = paintingsByPos[String(block.position)];
    return block;
  }

  function canSeeBlock(block: { position: Vec3 }): boolean {
    const headPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0) as Vec3;
    const range = headPos.distanceTo(block.position);
    const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos);
    const match = (inputBlock: BlockLike, iter: unknown): boolean => {
      const intersect = (iter as { intersect: (s: number[][], p: unknown) => unknown }).intersect(inputBlock.shapes, inputBlock.position);
      if (intersect) return true;
      return block.position.equals(inputBlock.position as Vec3);
    };
    const blockAtCursor = world.raycast(headPos, dir.normalize(), range, match);
    return Boolean(blockAtCursor && (blockAtCursor.position as Vec3).equals(block.position));
  }

  // -- block searches -------------------------------------------------------------------------------------------------
  function findBlocks(options: Bot): Vec3[] {
    const matching = options.matching;
    const point = ((options.point as Vec3 | undefined) ?? (bot.entity.position as Vec3)).floored();
    const maxDistance = (options.maxDistance as number) || 16;
    const count = (options.count as number) || 1;
    const useExtraInfo = options.useExtraInfo || false;
    if (typeof matching !== 'function' && typeof useExtraInfo !== 'function') return findByIds(matching, point, maxDistance, count);
    return findByMatcher(matching, useExtraInfo, point, maxDistance, count);
  }

  /** Block ids: the store's search, over this bot's columns only. */
  function findByIds(matching: unknown, point: Vec3, maxDistance: number, count: number): Vec3[] {
    if (world.dim === null) return [];
    const blocks = (Array.isArray(matching) ? matching : [matching]) as number[];
    const reader = world.host.botsReader;
    const query = { blocks };
    const key = matchKey(query);
    let match = matchCache.get(key);
    if (!match) {
      match = matchTable(reader.states, query);
      if (matchCache.size >= MATCH_CACHE_SIZE) matchCache.delete(matchCache.keys().next().value as string);
      matchCache.set(key, match);
    }
    const answer = findBlocksIn(reader, { dim: world.dim, x: point.x, y: point.y, z: point.z, maxDistance, count }, match, (cx, cz) => world.holds(cx, cz));
    const out: Vec3[] = [];
    const p = answer.positions;
    for (let i = 0; i < p.length; i += 3) out.push(new Vec3(p[i] as number, p[i + 1] as number, p[i + 2] as number));
    return out;
  }

  /** mineflayer's walk, over blockAt (a matcher function, or useExtraInfo as a function). */
  function findByMatcher(matching: unknown, useExtraInfo: unknown, point: Vec3, maxDistance: number, count: number): Vec3[] {
    const matcher: Matcher =
      typeof matching === 'function'
        ? (matching as Matcher)
        : ((ids: unknown[]) => (block: BlockLike | null) => (block === null ? false : ids.indexOf(block.type) >= 0))(Array.isArray(matching) ? matching : [matching]);
    const fullMatcher =
      typeof useExtraInfo === 'boolean'
        ? (p: Vec3): boolean => matcher(blockAt(p, useExtraInfo))
        : (p: Vec3): boolean => {
            const block = blockAt(p, true);
            return matcher(block) && (useExtraInfo as Matcher)(block);
          };
    const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16));
    const it = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16));
    const visitedSections = new Set<string>();
    let blocks: Vec3[] = [];
    let startedLayer = 0;
    let next: Vec3 | null = start;
    while (next) {
      const column = world.getColumn(next.x, next.z);
      const sectionY = next.y + Math.abs(bot.game.minY >> 4);
      const totalSections = bot.game.height >> 4;
      if (sectionY >= 0 && sectionY < totalSections && column && !visitedSections.has(next.toString())) {
        const begin = new Vec3(next.x * 16, sectionY * 16 + bot.game.minY, next.z * 16);
        if (useExtraInfo === true || mayHold(begin, matcher)) {
          const cursor = begin.clone();
          const end = cursor.offset(16, 16, 16);
          for (cursor.x = begin.x; cursor.x < end.x; cursor.x++) {
            for (cursor.y = begin.y; cursor.y < end.y; cursor.y++) {
              for (cursor.z = begin.z; cursor.z < end.z; cursor.z++) {
                if (fullMatcher(cursor) && cursor.distanceTo(point) <= maxDistance) blocks.push(cursor.clone());
              }
            }
          }
        }
        visitedSections.add(next.toString());
      }
      // If we started a layer, we have to finish it otherwise we might miss closer blocks
      if (startedLayer !== it.apothem && blocks.length >= count) break;
      startedLayer = it.apothem;
      next = it.next();
    }
    blocks.sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
    if (blocks.length > count) blocks = blocks.slice(0, count);
    return blocks;
  }

  /**
   * mineflayer's isBlockInSection: a section whose palette has no match is skipped. The store keeps no palette, so the
   * section's distinct states stand in for it, each tried as a palette Block (no position). A section of one state is
   * prismarine's single-value container, which has no palette: always read, as mineflayer reads it.
   */
  function mayHold(begin: Vec3, matcher: Matcher): boolean {
    const states = new Set<number>();
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) states.add(world.stateIdAt(begin.x + x, begin.y + y, begin.z + z));
      }
    }
    states.delete(-1);
    if (states.size <= 1) return true;
    for (const s of states) if (matcher(world.host.templates.at(s, null))) return true;
    return false;
  }

  function findBlock(options: Bot): BlockLike | null {
    const blocks = findBlocks(options);
    if (blocks.length === 0) return null;
    return bot.blockAt(blocks[0]) as BlockLike | null;
  }

  async function waitForChunksToLoad(): Promise<void> {
    const dist = 2;
    // This makes sure that the bot's real position has been already sent
    if (!bot.entity.height) await onceWithCleanup(bot, 'chunkColumnLoad', { timeout: 10000 });
    const pos = bot.entity.position as Vec3;
    const center = new Vec3((pos.x >> 4) << 4, 0, (pos.z >> 4) << 4);
    const chunkPosToCheck = new Set<string>();
    for (let x = -dist; x <= dist; x++) {
      for (let y = -dist; y <= dist; y++) {
        const p = center.plus(new Vec3(x, 0, y).scaled(16));
        if (!world.getColumnAt(p)) chunkPosToCheck.add(p.toString());
      }
    }
    if (chunkPosToCheck.size) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          world.off('chunkColumnLoad', waitForLoadEvents);
          reject(new Error(`Timeout waiting for ${chunkPosToCheck.size} chunks to load after 10000ms`));
        }, 10000);
        function waitForLoadEvents(columnCorner: Vec3): void {
          chunkPosToCheck.delete(columnCorner.toString());
          if (chunkPosToCheck.size === 0) {
            clearTimeout(timeout);
            world.off('chunkColumnLoad', waitForLoadEvents);
            resolve();
          }
        }
        world.on('chunkColumnLoad', waitForLoadEvents);
      });
    }
  }

  /** digging.js's prediction (the dug block is air at once): this bot's world only, see bot-world.ts. */
  function updateBlockState(point: Vec3, stateId: number): void {
    const oldBlock = blockAt(point);
    world.setBlockStateId(point, stateId);
    const newBlock = blockAt(point);
    if (newBlock === null || oldBlock === null) return;
    if (oldBlock.type !== newBlock.type) {
      const p = paintingsByPos[String(point.floored())];
      if (p) deletePainting(p);
    }
  }

  // -- packets (the blocks themselves come through SharedWorld: follow.ts) --------------------------------------------
  // Chunk batches: the server sends the next batch only once this one is acknowledged (mineflayer's code, as is).
  let chunkBatchStartTime = 0;
  let weightedAverage = 2;
  let oldSampleWeight = 1;
  bot._client.on('chunk_batch_start', () => {
    chunkBatchStartTime = Date.now();
  });
  bot._client.on('chunk_batch_finished', (packet: { batchSize: number }) => {
    const milliPerChunk = (Date.now() - chunkBatchStartTime) / packet.batchSize;
    const clampedMilliPerChunk = Math.min(Math.max(milliPerChunk, weightedAverage / 3.0), weightedAverage * 3.0);
    weightedAverage = (weightedAverage * oldSampleWeight + clampedMilliPerChunk) / (oldSampleWeight + 1);
    oldSampleWeight = Math.min(49, oldSampleWeight + 1);
    bot._client.write('chunk_batch_received', { chunksPerTick: 7 / weightedAverage });
  });

  // A column's block entities come with it; SharedWorld has already taken the column (its listener is older).
  bot._client.on('map_chunk', (packet: { x: number; z: number; blockEntities?: Array<{ x?: number; y?: number; z?: number; nbtData?: unknown }> }) => {
    // A column the bot does not hold (no login yet): mineflayer warns and ignores them.
    if (packet.blockEntities === undefined || !world.holds(packet.x, packet.z)) return;
    world._setBlockEntities(packet.x, packet.z, packet.blockEntities);
  });

  bot._client.on('open_sign_entity', (packet: { location: { x: number; y: number; z: number } }) => {
    const pos = new Vec3(packet.location.x, packet.location.y, packet.location.z);
    bot.emit('signOpen', bot.blockAt(pos));
  });

  bot._client.on('tile_entity_data', (packet: { location?: { x: number; y: number; z: number }; nbtData: { value: Record<string, { value: number }> } }) => {
    let at: Vec3;
    if (packet.location !== undefined) {
      at = new Vec3(packet.location.x, packet.location.y, packet.location.z);
    } else {
      const tag = packet.nbtData;
      at = new Vec3(tag.value.x!.value, tag.value.y!.value, tag.value.z!.value);
    }
    if (!world._setBlockEntity(at.x, at.y, at.z, packet.nbtData)) return;
    bot.emit('blockEntityData', bot.blockAt(at));
  });

  bot.updateSign = (block: { position: Vec3 }, text: string, back = false): void => {
    const lines = text.split('\n');
    if (lines.length > 4) {
      bot.emit('error', new Error('too many lines for sign text'));
      return;
    }
    for (const line of lines) {
      if (line.length > 45) {
        bot.emit('error', new Error('Signs have a maximum of 45 characters per line'));
        return;
      }
    }
    const signData = bot.supportFeature('sendStringifiedSignText')
      ? {
          text1: lines[0] ? JSON.stringify(lines[0]) : '""',
          text2: lines[1] ? JSON.stringify(lines[1]) : '""',
          text3: lines[2] ? JSON.stringify(lines[2]) : '""',
          text4: lines[3] ? JSON.stringify(lines[3]) : '""',
        }
      : { text1: lines[0] ?? '', text2: lines[1] ?? '', text3: lines[2] ?? '', text4: lines[3] ?? '' };
    bot._client.write('update_sign', { location: block.position, isFrontText: !back, ...signData });
  };

  // The world's name, as mineflayer's tests read it (the store's dimension name).
  bot._getDimensionName = (): string | null => world.dim;

  bot.findBlocks = findBlocks;
  bot.findBlock = findBlock;
  bot.canSeeBlock = canSeeBlock;
  bot.blockAt = blockAt;
  bot._updateBlockState = updateBlockState;
  bot.waitForChunksToLoad = waitForChunksToLoad;
}
