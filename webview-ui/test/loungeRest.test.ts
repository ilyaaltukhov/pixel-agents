/**
 * Idle agents rest in the lounge: when a turn ends the character gets up from
 * its desk, walks to a free lounge seat the office hands it, and sits there
 * (still, not typing). New work sends it back to the desk.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { WANDER_PAUSE_MIN_SEC } from '../src/constants.js';
import {
  createCharacter,
  getCharacterSprite,
  updateCharacter,
} from '../src/office/engine/characters.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import type { Character, Seat, TileType as TileTypeVal } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

const COLS = 8;
const ROWS = 3;

const desk: Seat = { uid: 'desk', seatCol: 0, seatRow: 1, facingDir: Direction.UP, assigned: true };
const sofa: Seat = {
  uid: 'sofa',
  seatCol: 6,
  seatRow: 1,
  facingDir: Direction.DOWN,
  assigned: false,
};

function setup(): {
  ch: Character;
  tick: (dt: number, claim?: (ch: Character) => string | null) => void;
} {
  const tileMap: TileTypeVal[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => TileType.FLOOR_1 as TileTypeVal),
  );
  const walkable = tileMap.flatMap((row, r) => row.map((_, c) => ({ col: c, row: r })));
  const seats = new Map([
    [desk.uid, desk],
    [sofa.uid, sofa],
  ]);
  // Furniture tiles are blocked; the own desk is opened by OfficeState per tick.
  const blocked = new Set([`${sofa.seatCol},${sofa.seatRow}`]);
  const ch = createCharacter(1, 0, desk.uid, desk);
  ch.state = CharacterState.TYPE;
  const tick = (dt: number, claim?: (ch: Character) => string | null): void =>
    updateCharacter(ch, dt, walkable, seats, tileMap, blocked, claim);
  return { ch, tick };
}

/** Advance in small steps until the predicate holds (or give up). */
function runUntil(tick: (dt: number) => void, done: () => boolean, maxSec = 30): void {
  for (let t = 0; t < maxSec && !done(); t += 0.05) tick(0.05);
}

test('an agent that goes idle walks to the lounge seat and sits there', () => {
  const { ch, tick } = setup();
  const claim = (): string => sofa.uid;
  ch.isActive = false;
  ch.seatTimer = -1; // turn-end sentinel from setAgentActive(false)

  tick(0.01, claim); // stands up
  assert.equal(ch.state, CharacterState.IDLE);

  runUntil(
    (dt) => tick(dt, claim),
    () => ch.state === CharacterState.WALK,
    WANDER_PAUSE_MIN_SEC + 1,
  );
  assert.equal(ch.restSeatId, sofa.uid, 'heads for the lounge, not a stroll');

  runUntil(
    (dt) => tick(dt, claim),
    () => ch.state === CharacterState.TYPE,
  );
  assert.deepEqual([ch.tileCol, ch.tileRow], [sofa.seatCol, sofa.seatRow]);
  assert.equal(ch.dir, sofa.facingDir);
  assert.ok(ch.seatTimer > 0, 'rests a while');

  const sprites = {
    typing: { [Direction.DOWN]: ['type0', 'type1'] },
    reading: { [Direction.DOWN]: ['read0', 'read1'] },
  } as unknown as CharacterSprites;
  assert.equal(getCharacterSprite(ch, sprites), 'read0', 'a still pose, not typing');
});

test('new work sends a resting agent back to its desk', () => {
  const { ch, tick } = setup();
  ch.state = CharacterState.TYPE;
  ch.tileCol = sofa.seatCol;
  ch.tileRow = sofa.seatRow;
  ch.restSeatId = sofa.uid;
  ch.isActive = true;

  tick(0.01);
  assert.equal(ch.restSeatId, null);
  runUntil(tick, () => ch.state === CharacterState.TYPE);
  assert.deepEqual([ch.tileCol, ch.tileRow], [desk.seatCol, desk.seatRow]);
});

test('without a free lounge seat it strolls instead of returning to the desk', () => {
  const { ch, tick } = setup();
  ch.isActive = false;
  ch.seatTimer = -1;
  tick(0.01);
  runUntil(tick, () => ch.state === CharacterState.WALK, WANDER_PAUSE_MIN_SEC + 1);
  assert.equal(ch.restSeatId, null);
  assert.ok(ch.wanderLimit > 0, 'fell back to the regular stroll-then-rest cycle');
});
