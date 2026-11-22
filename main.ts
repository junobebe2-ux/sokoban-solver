import * as fs from "node:fs";
import * as path from "node:path";

// Push-optimal Sokoban solver, written from the prose spec only.
// Design: split each level into rooms (dead-square cut of the hallway row),
// solve every room push-optimally with a breadth-first search over pushes
// (dead-square + frozen-2x2 pruning, fixed 250,000-state cap per room),
// then join the rooms' solutions with walks through the hallway.
// Fully deterministic: the search is budgeted by work (state count), never
// by the clock; no randomness, no clock reads, no environment reads.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Level = {
  w: number;
  h: number;
  open: Uint8Array; // 1 = open floor
  goal: Uint8Array; // 1 = goal square
  boxes: number[]; // sorted ascending
  player: number;
};

type Room = {
  boxes: number[];
  goals: number[];
};

type SearchResult = {
  moves: string;
  pushes: number;
  endPlayer: number;
};

// Directions in the fixed order up, down, left, right.
const DIR_LETTER = ["u", "d", "l", "r"];

// ---------------------------------------------------------------------------
// Parsing (XSB)
// ---------------------------------------------------------------------------

function parseLevel(text: string): Level {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const h = rows.length;
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  const n = w * h;
  const open = new Uint8Array(n);
  const goal = new Uint8Array(n);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const s = y * w + x;
      const ch = x < row.length ? row[x] : "#";
      if (ch !== "#") open[s] = 1;
      if (ch === "." || ch === "*" || ch === "+") goal[s] = 1;
      if (ch === "$" || ch === "*") boxes.push(s);
      if (ch === "@" || ch === "+") player = s;
    }
  }
  // Force the outermost frame to be wall, whatever it shows.
  for (let x = 0; x < w; x++) {
    open[x] = 0;
    open[(h - 1) * w + x] = 0;
  }
  for (let y = 0; y < h; y++) {
    open[y * w] = 0;
    open[y * w + (w - 1)] = 0;
  }
  boxes.sort((a, b) => a - b);
  return { w, h, open, goal, boxes, player };
}

// ---------------------------------------------------------------------------
// Dead squares: pull backwards from the goals, ignoring the other boxes.
// A square is dead when no push can ever bring a box from it onto any goal.
// ---------------------------------------------------------------------------

function computeDead(lv: Level): Uint8Array {
  const { w, h, open, goal } = lv;
  const n = w * h;
  const OFF = [-w, w, -1, 1];
  const live = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let s = 0; s < n; s++) {
    if (goal[s]) {
      live[s] = 1;
      q[qt++] = s;
    }
  }
  while (qh < qt) {
    const x = q[qh++];
    for (let k = 0; k < 4; k++) {
      const d = OFF[k];
      const y = x - d;
      if (y < 0 || y >= n) continue;
      const stand = y - d;
      if (stand < 0 || stand >= n) continue;
      if (!live[y] && open[y] && open[stand]) {
        live[y] = 1;
        q[qt++] = y;
      }
    }
  }
  const dead = new Uint8Array(n);
  for (let s = 0; s < n; s++) if (open[s] && !live[s]) dead[s] = 1;
  return dead;
}

// ---------------------------------------------------------------------------
// Find the rooms: cut every dead open square of the hallway row (the row the
// player stands on); what is left falls into connected parts. Each part that
// holds a box is a room. Returns null when the level does not split cleanly.
// ---------------------------------------------------------------------------

function findRooms(lv: Level, dead: Uint8Array): Room[] | null {
  const { w, h, open } = lv;
  const n = w * h;
  const OFF = [-w, w, -1, 1];
  const hallRow = Math.floor(lv.player / w);
  const cut = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    const s = hallRow * w + x;
    if (open[s] && dead[s]) cut[s] = 1;
  }
  // A box or a goal in a cut square means the level does not split.
  for (const b of lv.boxes) if (cut[b]) return null;
  for (let s = 0; s < n; s++) if (lv.goal[s] && cut[s]) return null;

  const comp = new Int32Array(n); // component id per square, 0 = none
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  const rooms: Room[] = [];
  let compId = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (!open[s0] || cut[s0] || seen[s0]) continue;
    compId++;
    let qh = 0;
    let qt = 0;
    q[qt++] = s0;
    seen[s0] = 1;
    comp[s0] = compId;
    const goals: number[] = [];
    while (qh < qt) {
      const s = q[qh++];
      if (lv.goal[s]) goals.push(s);
      for (let k = 0; k < 4; k++) {
        const t = s + OFF[k];
        if (t < 0 || t >= n) continue;
        if (open[t] && !cut[t] && !seen[t]) {
          seen[t] = 1;
          comp[t] = compId;
          q[qt++] = t;
        }
      }
    }
    const boxes: number[] = [];
    for (const b of lv.boxes) if (comp[b] === compId) boxes.push(b);
    if (boxes.length !== goals.length) return null;
    if (boxes.length > 0) rooms.push({ boxes, goals });
  }
  // Every box and every goal must belong to exactly one room.
  let countedBoxes = 0;
  let countedGoals = 0;
  for (const r of rooms) {
    countedBoxes += r.boxes.length;
    countedGoals += r.goals.length;
  }
  let totalGoals = 0;
  for (let s = 0; s < n; s++) if (lv.goal[s]) totalGoals++;
  if (countedBoxes !== lv.boxes.length || countedGoals !== totalGoals) return null;
  return rooms;
}

// ---------------------------------------------------------------------------
// Push-optimal search for one room (or the whole level as fallback).
//
// A state is the boxes (sorted) plus the player's reachable region, named by
// the region's LOWEST square. The region is the connected component of open
// squares (walls and boxes block the walk) containing that square, so the
// lowest square names it exactly. Breadth-first over pushes: the first
// solved state met is push-optimal.
// ---------------------------------------------------------------------------

function pushSearch(
  w: number,
  blocked: Uint8Array, // 1 = wall for this search (level walls + other rooms' boxes)
  goal: Uint8Array, // 1 = goal square for this search
  dead: Uint8Array, // level-wide dead squares
  boxes0: number[], // sorted
  player0: number,
  cap: number,
): SearchResult | null {
  const n = blocked.length;
  const OFF = [-w, w, -1, 1];
  const nb = boxes0.length;

  // Already solved: no moves at all.
  let solved0 = true;
  for (const b of boxes0) if (!goal[b]) { solved0 = false; break; }
  if (solved0) return { moves: "", pushes: 0, endPlayer: player0 };

  // Flood-fill scratch (stamp counters: no array clearing per fill).
  const fillQ = new Int32Array(n);
  const fillSeen = new Int32Array(n);
  const occMark = new Int32Array(n);
  let stamp = 0;
  let curFillId = 0;

  // Flood the player's region from `start` with `boxes` as obstacles.
  // Returns the region's lowest square; leaves fillSeen stamped with the
  // fill's id (test membership with fillSeen[s] === curFillId) and the boxes
  // marked in occMark with the same id.
  function flood(start: number, boxes: number[]): number {
    const id = ++stamp;
    curFillId = id;
    for (let i = 0; i < boxes.length; i++) occMark[boxes[i]] = id;
    let qh = 0;
    let qt = 0;
    fillQ[qt++] = start;
    fillSeen[start] = id;
    let low = start;
    while (qh < qt) {
      const s = fillQ[qh++];
      if (s < low) low = s;
      for (let k = 0; k < 4; k++) {
        const t = s + OFF[k];
        if (t < 0 || t >= n) continue;
        if (fillSeen[t] !== id && !blocked[t] && occMark[t] !== id) {
          fillSeen[t] = id;
          fillQ[qt++] = t;
        }
      }
    }
    return low;
  }

  // Frozen 2x2 check on the position after a push: look at the four 2x2
  // blocks containing the target square; if all four squares of a block are
  // wall-or-box and at least one of them holds a box off its goal, prune.
  function frozen2x2(target: number, boxes: number[]): boolean {
    const tls = [target, target - 1, target - w, target - w - 1];
    for (let i = 0; i < 4; i++) {
      const tl = tls[i];
      const sqs = [tl, tl + 1, tl + w, tl + w + 1];
      let allWallOrBox = true;
      let hasBoxOffGoal = false;
      for (let j = 0; j < 4; j++) {
        const s = sqs[j];
        if (s < 0 || s >= n) { allWallOrBox = false; break; }
        const isBox = boxes.indexOf(s) !== -1;
        if (!blocked[s] && !isBox) { allWallOrBox = false; break; }
        if (isBox && !goal[s]) hasBoxOffGoal = true;
      }
      if (allWallOrBox && hasBoxOffGoal) return true;
    }
    return false;
  }

  // Shortest walk from `from` to `to` over open squares with `boxes` as
  // obstacles. Neighbours in the order up, down, left, right; first visit
  // wins, so the walk is deterministic.
  function walkPath(from: number, to: number, boxes: number[]): string {
    if (from === to) return "";
    const par = new Int32Array(n).fill(-1);
    const parDir = new Int8Array(n);
    const q = new Int32Array(n);
    let qh = 0;
    let qt = 0;
    q[qt++] = from;
    par[from] = from;
    while (qh < qt) {
      const s = q[qh++];
      if (s === to) break;
      for (let k = 0; k < 4; k++) {
        const t = s + OFF[k];
        if (t < 0 || t >= n) continue;
        if (par[t] !== -1) continue;
        if (blocked[t]) continue;
        if (boxes.indexOf(t) !== -1) continue;
        par[t] = s;
        parDir[t] = k;
        q[qt++] = t;
      }
    }
    if (par[to] === -1) return "";
    const letters: string[] = [];
    let s = to;
    while (s !== from) {
      letters.push(DIR_LETTER[parDir[s]]);
      s = par[s];
    }
    letters.reverse();
    return letters.join("");
  }

  // Per-state storage, kept flat.
  const stBoxes: number[] = []; // stride nb
  const stParent: number[] = [];
  const stPushSq: number[] = [];
  const stPushDir: number[] = [];
  const stLow: number[] = [];
  const visited = new Set<string>();
  const queue: number[] = [];
  let qHead = 0;
  let created = 0;

  function keyOf(boxes: number[], low: number): string {
    let k = "";
    for (let i = 0; i < boxes.length; i++) k += String.fromCharCode(boxes[i]);
    k += String.fromCharCode(low);
    return k;
  }

  function addState(
    boxes: number[],
    parent: number,
    pushSq: number,
    pushDir: number,
    low: number,
  ): number {
    const idx = created++;
    for (let i = 0; i < nb; i++) stBoxes.push(boxes[i]);
    stParent.push(parent);
    stPushSq.push(pushSq);
    stPushDir.push(pushDir);
    stLow.push(low);
    return idx;
  }

  // Reconstruct the moves for the path ending in state `goalSi`.
  function reconstruct(goalSi: number): SearchResult {
    const pushes: { sq: number; dir: number }[] = [];
    let cur = goalSi;
    while (stParent[cur] !== -1) {
      pushes.push({ sq: stPushSq[cur], dir: stPushDir[cur] });
      cur = stParent[cur];
    }
    pushes.reverse();
    let player = player0;
    const boxes = boxes0.slice();
    let moves = "";
    for (const p of pushes) {
      const behind = p.sq - OFF[p.dir];
      moves += walkPath(player, behind, boxes);
      moves += DIR_LETTER[p.dir];
      const bi = boxes.indexOf(p.sq);
      boxes[bi] = p.sq + OFF[p.dir];
      boxes.sort((a, b) => a - b);
      player = p.sq;
    }
    return { moves, pushes: pushes.length, endPlayer: player };
  }

  // Root state.
  const rootLow = flood(player0, boxes0);
  addState(boxes0, -1, -1, -1, rootLow);
  visited.add(keyOf(boxes0, rootLow));
  queue.push(0);

  const candBox: number[] = [];
  const candDir: number[] = [];

  while (qHead < queue.length) {
    const si = queue[qHead++];
    const base = si * nb;
    const boxes: number[] = [];
    for (let i = 0; i < nb; i++) boxes.push(stBoxes[base + i]);
    const low = stLow[si];

    // Flood the player's region from its lowest square.
    flood(low, boxes);
    const rid = curFillId;

    // Collect every possible push from this state.
    candBox.length = 0;
    candDir.length = 0;
    for (let i = 0; i < nb; i++) {
      const b = boxes[i];
      for (let k = 0; k < 4; k++) {
        const off = OFF[k];
        const behind = b - off;
        const beyond = b + off;
        if (behind < 0 || behind >= n) continue;
        if (beyond < 0 || beyond >= n) continue;
        if (fillSeen[behind] !== rid) continue; // player cannot stand behind
        if (blocked[beyond]) continue; // wall
        if (occMark[beyond] === rid) continue; // occupied by a box
        if (dead[beyond]) continue; // dead square
        candBox.push(b);
        candDir.push(k);
      }
    }

    for (let c = 0; c < candBox.length; c++) {
      const b = candBox[c];
      const k = candDir[c];
      const off = OFF[k];
      const beyond = b + off;
      const nb2 = boxes.slice();
      const bi = nb2.indexOf(b);
      nb2[bi] = beyond;
      nb2.sort((a, b2) => a - b2);
      if (frozen2x2(beyond, nb2)) continue;

      // Solved? The first solved state met is push-optimal.
      let solved = true;
      for (let i = 0; i < nb; i++) if (!goal[nb2[i]]) { solved = false; break; }
      if (solved) {
        const nsi = addState(nb2, si, b, k, flood(b, nb2));
        return reconstruct(nsi);
      }

      // The player's new region: flood from the box's old square, where
      // the player stands after the push.
      const cLow = flood(b, nb2);
      const key = keyOf(nb2, cLow);
      if (visited.has(key)) continue;
      if (created >= cap) return null; // fixed work cap, never the clock
      visited.add(key);
      const nsi = addState(nb2, si, b, k, cLow);
      queue.push(nsi);
    }
  }
  return null; // search exhausted: unsolved
}

// ---------------------------------------------------------------------------
// Solve one level: room by room, whole-level search as fallback.
// ---------------------------------------------------------------------------

function solveLevel(text: string): { moves: string; pushes: number } {
  const lv = parseLevel(text);
  const dead = computeDead(lv);
  const n = lv.w * lv.h;
  const rooms = findRooms(lv, dead);

  if (rooms !== null && rooms.length > 0) {
    let moves = "";
    let pushes = 0;
    let player = lv.player;
    const solvedFlags: boolean[] = rooms.map(() => false);
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri];
      // Sub-level walls: level walls plus every OTHER room's boxes
      // (a solved room's boxes sit on its goals, so wall its goal squares).
      const blocked = new Uint8Array(n);
      for (let s = 0; s < n; s++) if (!lv.open[s]) blocked[s] = 1;
      for (let rj = 0; rj < rooms.length; rj++) {
        if (rj === ri) continue;
        if (solvedFlags[rj]) {
          for (const g of rooms[rj].goals) blocked[g] = 1;
        } else {
          for (const b of rooms[rj].boxes) blocked[b] = 1;
        }
      }
      const goalArr = new Uint8Array(n);
      for (const g of room.goals) goalArr[g] = 1;
      const res = pushSearch(lv.w, blocked, goalArr, dead, room.boxes.slice(), player, 250000);
      if (res === null) {
        // Give up on this room: keep the moves for the rooms solved so far.
        return { moves, pushes };
      }
      moves += res.moves;
      pushes += res.pushes;
      player = res.endPlayer;
      solvedFlags[ri] = true;
    }
    return { moves, pushes };
  }

  // Fallback: search the whole level at once.
  const blocked = new Uint8Array(n);
  for (let s = 0; s < n; s++) if (!lv.open[s]) blocked[s] = 1;
  const res = pushSearch(lv.w, blocked, lv.goal, dead, lv.boxes.slice(), lv.player, 250000);
  if (res === null) return { moves: "", pushes: 0 };
  return { moves: res.moves, pushes: res.pushes };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    let moves = "";
    try {
      const levelText = fs.readFileSync(path.join(inputDir, id, "level.txt"), "utf-8");
      moves = solveLevel(levelText).moves;
    } catch {
      // A missing or broken instance still gets a (valid, empty) answer file.
      moves = "";
    }
    const outDir = path.join(outputDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "solution.txt"), moves + "\n", "utf-8");
  }
}

main();
