import { cellKey, makeCellSet } from './mazeFormat.js';

export const RACER_COLORS = [
  { id: 'yellow', color: '#facc15', speed: 3.15, angle: -1.75 },
  { id: 'red', color: '#ef4444', speed: 2.95, angle: -1.75 },
  { id: 'green', color: '#22c55e', speed: 2.75, angle: -1.75 },
  { id: 'blue', color: '#3b82f6', speed: 2.55, angle: -1.69 }
];

const HALF_SIZE = 0.26;
const MAX_STEP = 0.035;
const MIN_COMPONENT = 0.12;

export function createRacers(maze) {
  const startX = maze.start.x + 0.5;
  const startY = maze.start.y + 0.5;
  const offsets = [
    { x: -0.16, y: -0.16 },
    { x: 0.16, y: -0.16 },
    { x: -0.16, y: 0.16 },
    { x: 0.16, y: 0.16 }
  ];

  return RACER_COLORS.map((racer, index) => ({
    id: racer.id,
    color: racer.color,
    halfSize: HALF_SIZE,
    x: startX + offsets[index].x,
    y: startY + offsets[index].y,
    vx: Math.cos(racer.angle) * racer.speed,
    vy: Math.sin(racer.angle) * racer.speed,
    speed: racer.speed,
    hasKnife: false,
    hasShield: false,
    speedBoosted: false,
    eliminated: false,
    eliminatedBy: null,
    finished: false,
    finishTime: null,
    placement: null
  }));
}

export function createPhysicsWorld(maze) {
  return {
    maze,
    openCells: makeCellSet(maze.corridor.cells),
    solidCells: new Set(),
    onSolidCellHit: null
  };
}

export function setSolidCells(world, cells) {
  world.solidCells = new Set(cells);
}

export function stepRacers(world, racers, deltaTime) {
  const activeRacers = racers.filter((racer) => !racer.finished && !racer.eliminated);
  const maxDistance = activeRacers.reduce((max, racer) => {
    return Math.max(max, Math.hypot(racer.vx * deltaTime, racer.vy * deltaTime));
  }, 0);
  const steps = Math.max(1, Math.ceil(maxDistance / MAX_STEP));
  const dt = deltaTime / steps;

  for (let i = 0; i < steps; i += 1) {
    activeRacers.forEach((racer) => moveRacerStep(world, racer, dt));
    resolveRacerCollisions(activeRacers);
    activeRacers.forEach(keepVelocityUseful);
  }
}

export function isRacerInsideOpenCells(world, racer) {
  return canOccupy(world, racer.x, racer.y, racer.halfSize, true);
}

export function racerCell(racer) {
  return { x: Math.floor(racer.x), y: Math.floor(racer.y) };
}

function resolveRacerCollisions(racers) {
  for (let i = 0; i < racers.length; i += 1) {
    for (let j = i + 1; j < racers.length; j += 1) {
      resolveRacerCollision(racers[i], racers[j]);
    }
  }
}

function resolveRacerCollision(a, b) {
  const minDistance = a.halfSize + b.halfSize;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);

  if (distance >= minDistance) return;

  const nx = distance > 0 ? dx / distance : 1;
  const ny = distance > 0 ? dy / distance : 0;
  const overlap = minDistance - distance;

  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const relativeVx = a.vx - b.vx;
  const relativeVy = a.vy - b.vy;
  const velocityAlongNormal = relativeVx * nx + relativeVy * ny;

  if (velocityAlongNormal <= 0) return;

  const impulse = velocityAlongNormal;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
  normalizeVelocity(a);
  normalizeVelocity(b);
}

function moveRacerStep(world, racer, deltaTime) {
  moveAxis(world, racer, 'x', racer.vx * deltaTime);
  moveAxis(world, racer, 'y', racer.vy * deltaTime);
}

function moveAxis(world, racer, axis, amount) {
  const nextX = axis === 'x' ? racer.x + amount : racer.x;
  const nextY = axis === 'y' ? racer.y + amount : racer.y;

  if (canOccupy(world, nextX, nextY, racer.halfSize)) {
    racer.x = nextX;
    racer.y = nextY;
    return;
  }

  const blockedCells = blockedCellsFor(world, nextX, nextY, racer.halfSize);
  if (world.onSolidCellHit) {
    world.onSolidCellHit(racer, blockedCells);
  }

  if (axis === 'x') {
    racer.vx *= -1;
  } else {
    racer.vy *= -1;
  }
}

function canOccupy(world, x, y, halfSize, ignoreDynamicSolids = false) {
  return isOpenPoint(world, x - halfSize, y - halfSize, ignoreDynamicSolids)
    && isOpenPoint(world, x + halfSize, y - halfSize, ignoreDynamicSolids)
    && isOpenPoint(world, x - halfSize, y + halfSize, ignoreDynamicSolids)
    && isOpenPoint(world, x + halfSize, y + halfSize, ignoreDynamicSolids);
}

function blockedCellsFor(world, x, y, halfSize) {
  const points = [
    { x: x - halfSize, y: y - halfSize },
    { x: x + halfSize, y: y - halfSize },
    { x: x - halfSize, y: y + halfSize },
    { x: x + halfSize, y: y + halfSize }
  ];
  const cells = [];
  const seen = new Set();

  points.forEach((point) => {
    const cellX = Math.floor(point.x);
    const cellY = Math.floor(point.y);
    const key = cellKey(cellX, cellY);
    if (!seen.has(key) && (!world.openCells.has(key) || world.solidCells.has(key))) {
      seen.add(key);
      cells.push({ x: cellX, y: cellY, key });
    }
  });

  return cells;
}

function isOpenPoint(world, x, y, ignoreDynamicSolids) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const key = cellKey(cellX, cellY);
  return world.openCells.has(key) && (ignoreDynamicSolids || !world.solidCells.has(key));
}

function keepVelocityUseful(racer) {
  if (Math.abs(racer.vx) < MIN_COMPONENT) {
    racer.vx = Math.sign(racer.vx || 1) * MIN_COMPONENT;
    normalizeVelocity(racer);
  }

  if (Math.abs(racer.vy) < MIN_COMPONENT) {
    racer.vy = Math.sign(racer.vy || -1) * MIN_COMPONENT;
    normalizeVelocity(racer);
  }
}

function normalizeVelocity(racer) {
  const length = Math.hypot(racer.vx, racer.vy) || 1;
  racer.vx = (racer.vx / length) * racer.speed;
  racer.vy = (racer.vy / length) * racer.speed;
}
