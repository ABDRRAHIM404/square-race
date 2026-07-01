import { cellKey } from './mazeFormat.js';
import { RACER_COLORS, createPhysicsWorld, createRacers, racerCell, setSolidCells, stepRacers } from './physics.js';

const FINISH_RADIUS = 0.5;
const TOUCH_DISTANCE = 0.58;
const WALL_SPEED = Math.min(...RACER_COLORS.map((racer) => racer.speed)) * 0.2;

export function createRace(maze, options = {}) {
  const race = {
    maze,
    options: {
      enableLoot: options.enableLoot !== false,
      enableBricks: options.enableBricks !== false,
      enablePursuingWall: options.enablePursuingWall !== false
    },
    world: createPhysicsWorld(maze),
    racers: createRacers(maze),
    loot: maze.lootZones.map((zone) => ({ ...zone, pickedUp: false })),
    bricks: maze.bricks.map((brick) => ({ ...brick, broken: false })),
    pursuingWall: createPursuingWall(maze),
    placements: [],
    elapsed: 0,
    complete: false
  };

  race.world.onSolidCellHit = (_racer, blockedCells) => {
    if (race.options.enableBricks) {
      breakTouchedBricks(race, blockedCells);
    }
  };

  updateDynamicSolids(race);
  return race;
}

export function updateRace(race, deltaTime) {
  if (race.complete) return;

  race.elapsed += deltaTime;
  updatePursuingWall(race, deltaTime);
  updateDynamicSolids(race);
  stepRacers(race.world, race.racers, deltaTime);

  if (race.options.enableLoot) {
    collectLoot(race);
    resolveKnifeTouches(race);
  }

  recordFinishedRacers(race);
  resolveDeadEndWallKills(race);
  recordSoleSurvivor(race);
  race.complete = race.placements.length === race.racers.length;
}

export function getActiveSolidCells(race) {
  const solidCells = [];

  if (race.options.enableBricks) {
    race.bricks.forEach((brick) => {
      if (!brick.broken) solidCells.push(cellKey(brick.x, brick.y));
    });
  }

  if (race.options.enablePursuingWall) {
    const occupiedCells = getActiveRacerFootprintCells(race);

    race.pursuingWall.filledCells.forEach((key) => {
      if (!occupiedCells.has(key)) solidCells.push(key);
    });
  }

  return solidCells;
}

function updateDynamicSolids(race) {
  setSolidCells(race.world, getActiveSolidCells(race));
}

function getActiveRacerFootprintCells(race) {
  const cells = new Set();

  race.racers
    .filter((racer) => !racer.finished && !racer.eliminated)
    .forEach((racer) => {
      const minX = Math.floor(racer.x - racer.halfSize);
      const maxX = Math.floor(racer.x + racer.halfSize);
      const minY = Math.floor(racer.y - racer.halfSize);
      const maxY = Math.floor(racer.y + racer.halfSize);

      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          cells.add(cellKey(x, y));
        }
      }
    });

  return cells;
}

function collectLoot(race) {
  race.racers.forEach((racer) => {
    if (racer.finished || racer.eliminated) return;

    race.loot.forEach((zone) => {
      if (zone.pickedUp) return;

      const distance = Math.hypot(racer.x - (zone.x + 0.5), racer.y - (zone.y + 0.5));
      if (distance <= TOUCH_DISTANCE || currentCellMatches(racer, zone)) {
        zone.pickedUp = true;
        if (zone.type === 'knife') racer.hasKnife = true;
        if (zone.type === 'shield') racer.hasShield = true;
        if (zone.type === 'speedBoost' && race.maze.toggles.speedBoost) applySpeedBoost(racer);
      }
    });
  });
}

function applySpeedBoost(racer) {
  if (racer.speedBoosted) return;

  const newSpeed = racer.speed * 1.3;
  const length = Math.hypot(racer.vx, racer.vy) || 1;
  racer.speed = newSpeed;
  racer.vx = (racer.vx / length) * newSpeed;
  racer.vy = (racer.vy / length) * newSpeed;
  racer.speedBoosted = true;
}

function resolveKnifeTouches(race) {
  for (let i = 0; i < race.racers.length; i += 1) {
    for (let j = i + 1; j < race.racers.length; j += 1) {
      const a = race.racers[i];
      const b = race.racers[j];
      if (!canTouch(a, b)) continue;

      if (a.hasKnife) applyKnifeHit(race, a, b);
      if (b.hasKnife) applyKnifeHit(race, b, a);
    }
  }
}

function canTouch(a, b) {
  if (a.finished || a.eliminated || b.finished || b.eliminated) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= a.halfSize + b.halfSize;
}

function applyKnifeHit(race, attacker, target) {
  if (attacker.eliminated || target.eliminated || target.finished) return;

  if (target.hasShield) {
    target.hasShield = false;
    return;
  }

  eliminateRacer(race, target, 'knife');
}

function breakTouchedBricks(race, blockedCells) {
  const blocked = new Set(blockedCells.map((cell) => cell.key));
  race.bricks.forEach((brick) => {
    if (!brick.broken && blocked.has(cellKey(brick.x, brick.y))) {
      brick.broken = true;
    }
  });
  updateDynamicSolids(race);
}

function recordSoleSurvivor(race) {
  if (race.placements.length !== race.racers.length - 1) return;

  const survivor = race.racers.find((racer) => !racer.finished && !racer.eliminated);
  if (!survivor) return;

  survivor.finished = true;
  survivor.finishTime = race.elapsed;
  survivor.placement = nextFinishPlacement(race);
  race.placements.push({
    racerId: survivor.id,
    placement: survivor.placement,
    time: survivor.finishTime,
    status: 'finished'
  });
}

function recordFinishedRacers(race) {
  const exitX = race.maze.exit.x + 0.5;
  const exitY = race.maze.exit.y + 0.5;

  race.racers.forEach((racer) => {
    if (racer.finished || racer.eliminated) return;

    const distance = Math.hypot(racer.x - exitX, racer.y - exitY);
    if (distance <= FINISH_RADIUS || currentCellMatches(racer, race.maze.exit)) {
      racer.finished = true;
      racer.finishTime = race.elapsed;
      racer.placement = nextFinishPlacement(race);
      race.placements.push({
        racerId: racer.id,
        placement: racer.placement,
        time: racer.finishTime,
        status: 'finished'
      });
    }
  });
}

function eliminateRacer(race, racer, reason) {
  if (racer.finished || racer.eliminated) return;

  racer.eliminated = true;
  racer.eliminatedBy = reason;
  racer.vx = 0;
  racer.vy = 0;
  racer.placement = nextEliminationPlacement(race);
  race.placements.push({
    racerId: racer.id,
    placement: racer.placement,
    time: race.elapsed,
    status: 'eliminated',
    reason
  });
}

function nextFinishPlacement(race) {
  const used = new Set(race.placements.map((placement) => placement.placement));
  for (let placement = 1; placement <= race.racers.length; placement += 1) {
    if (!used.has(placement)) return placement;
  }
  return race.racers.length;
}

function nextEliminationPlacement(race) {
  const used = new Set(race.placements.map((placement) => placement.placement));
  for (let placement = race.racers.length; placement >= 1; placement -= 1) {
    if (!used.has(placement)) return placement;
  }
  return race.racers.length;
}

function createPursuingWall(maze) {
  const path = buildStartToExitPath(maze);
  const distances = new Map(path.map((cell, index) => [cellKey(cell.x, cell.y), index]));
  return {
    speed: WALL_SPEED,
    progress: 0,
    path,
    distances,
    filledCells: new Set(),
    front: null
  };
}

function updatePursuingWall(race, deltaTime) {
  if (!race.options.enablePursuingWall) return;

  const trailingDistance = getTrailingActiveDistance(race);
  const maxProgressBehindPack = Math.max(0, trailingDistance - 0.25);
  race.pursuingWall.progress = Math.min(
    race.pursuingWall.progress + race.pursuingWall.speed * deltaTime,
    maxProgressBehindPack,
    Math.max(0, race.pursuingWall.path.length)
  );
  race.pursuingWall.filledCells = new Set();

  race.pursuingWall.path.forEach((cell, index) => {
    if (index + 1 <= race.pursuingWall.progress) {
      race.pursuingWall.filledCells.add(cellKey(cell.x, cell.y));
    }
  });

  race.pursuingWall.front = getPursuingWallFront(race.pursuingWall);
}

function getTrailingActiveDistance(race) {
  const activeDistances = race.racers
    .filter((racer) => !racer.finished && !racer.eliminated)
    .map((racer) => {
      const cell = racerCell(racer);
      return race.pursuingWall.distances.get(cellKey(cell.x, cell.y));
    })
    .filter((distance) => Number.isFinite(distance));

  return activeDistances.length === 0 ? Infinity : Math.min(...activeDistances);
}

function getPursuingWallFront(wall) {
  if (wall.path.length === 0 || wall.progress >= wall.path.length) return null;

  const index = Math.floor(wall.progress);
  const cell = wall.path[index];
  const next = wall.path[Math.min(index + 1, wall.path.length - 1)];
  return {
    cell,
    next,
    fraction: wall.progress - index
  };
}

function buildStartToExitPath(maze) {
  const open = new Set(maze.corridor.cells.map((cell) => cellKey(cell.x, cell.y)));
  const startKey = cellKey(maze.start.x, maze.start.y);
  const exitKey = cellKey(maze.exit.x, maze.exit.y);
  const cameFrom = new Map();
  const queue = [{ x: maze.start.x, y: maze.start.y }];
  cameFrom.set(startKey, null);

  for (let index = 0; index < queue.length; index += 1) {
    const cell = queue[index];
    const key = cellKey(cell.x, cell.y);
    if (key === exitKey) break;

    getNeighbors(cell).forEach((neighbor) => {
      const neighborKey = cellKey(neighbor.x, neighbor.y);
      if (open.has(neighborKey) && !cameFrom.has(neighborKey)) {
        cameFrom.set(neighborKey, key);
        queue.push(neighbor);
      }
    });
  }

  if (!cameFrom.has(exitKey)) return [{ x: maze.start.x, y: maze.start.y }];

  const path = [];
  let key = exitKey;
  while (key) {
    const [x, y] = key.split(',').map(Number);
    path.push({ x, y });
    key = cameFrom.get(key);
  }

  return path.reverse();
}

function getNeighbors(cell) {
  return [
    { x: cell.x + 1, y: cell.y },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x, y: cell.y - 1 }
  ];
}

function resolveDeadEndWallKills(race) {
  if (!race.options.enablePursuingWall) return;

  race.racers.forEach((racer) => {
    if (racer.finished || racer.eliminated) return;

    const cell = racerCell(racer);
    const deadEnd = race.maze.deadEnds.find((candidate) => (
      candidate.cells.some((deadCell) => deadCell.x === cell.x && deadCell.y === cell.y)
    ));

    if (!deadEnd) return;

    const mouthKey = cellKey(deadEnd.mouth.x, deadEnd.mouth.y);
    if (race.pursuingWall.filledCells.has(mouthKey)) {
      eliminateRacer(race, racer, 'pursuing-wall');
    }
  });
}

function currentCellMatches(racer, cell) {
  return Math.floor(racer.x) === cell.x && Math.floor(racer.y) === cell.y;
}
