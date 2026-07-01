export const MAZE_SCHEMA_VERSION = 1;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ITEM_TYPES = new Set(['knife', 'shield', 'speedBoost']);

export function validateMaze(maze) {
  const errors = [];

  if (!isPlainObject(maze)) {
    return { valid: false, errors: ['maze must be an object'] };
  }

  requireNumber(maze.schemaVersion, 'schemaVersion', errors);
  if (maze.schemaVersion !== MAZE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MAZE_SCHEMA_VERSION}`);
  }

  requireString(maze.id, 'id', errors);
  requireString(maze.name, 'name', errors);
  requireIsoDate(maze.createdAt, 'createdAt', errors);
  requireIsoDate(maze.modifiedAt, 'modifiedAt', errors);

  validateGrid(maze.grid, errors);
  validateCorridor(maze.corridor, maze.grid, errors);
  validatePoint(maze.start, 'start', maze.grid, errors);
  validatePoint(maze.exit, 'exit', maze.grid, errors);
  validateDeadEnds(maze.deadEnds, maze.grid, errors);
  validateBricks(maze.bricks, maze.grid, errors);
  validateLootZones(maze.lootZones, maze.grid, errors);
  validateToggles(maze.toggles, errors);

  return { valid: errors.length === 0, errors };
}

export function cellKey(x, y) {
  return `${x},${y}`;
}

export function makeCellSet(cells) {
  return new Set(cells.map((cell) => cellKey(cell.x, cell.y)));
}

function validateGrid(grid, errors) {
  if (!isPlainObject(grid)) {
    errors.push('grid must be an object');
    return;
  }

  requireInteger(grid.cols, 'grid.cols', errors);
  requireInteger(grid.rows, 'grid.rows', errors);
  requireInteger(grid.cellSize, 'grid.cellSize', errors);

  if (grid.cols <= 0) errors.push('grid.cols must be greater than 0');
  if (grid.rows <= 0) errors.push('grid.rows must be greater than 0');
  if (grid.cellSize <= 0) errors.push('grid.cellSize must be greater than 0');
}

function validateCorridor(corridor, grid, errors) {
  if (!isPlainObject(corridor)) {
    errors.push('corridor must be an object');
    return;
  }

  if (!Array.isArray(corridor.cells)) {
    errors.push('corridor.cells must be an array');
    return;
  }

  if (corridor.cells.length === 0) {
    errors.push('corridor.cells must contain at least one cell');
  }

  const seen = new Set();
  corridor.cells.forEach((cell, index) => {
    validatePoint(cell, `corridor.cells[${index}]`, grid, errors);
    if (isGridPoint(cell, grid)) {
      const key = cellKey(cell.x, cell.y);
      if (seen.has(key)) errors.push(`corridor.cells[${index}] duplicates ${key}`);
      seen.add(key);
    }
  });
}

function validateDeadEnds(deadEnds, grid, errors) {
  if (!Array.isArray(deadEnds)) {
    errors.push('deadEnds must be an array');
    return;
  }

  deadEnds.forEach((deadEnd, index) => {
    const prefix = `deadEnds[${index}]`;
    if (!isPlainObject(deadEnd)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    requireString(deadEnd.id, `${prefix}.id`, errors);
    validatePoint(deadEnd.mouth, `${prefix}.mouth`, grid, errors);

    if (!Array.isArray(deadEnd.cells) || deadEnd.cells.length === 0) {
      errors.push(`${prefix}.cells must be a non-empty array`);
      return;
    }

    deadEnd.cells.forEach((cell, cellIndex) => {
      validatePoint(cell, `${prefix}.cells[${cellIndex}]`, grid, errors);
    });
  });
}

function validateBricks(bricks, grid, errors) {
  if (!Array.isArray(bricks)) {
    errors.push('bricks must be an array');
    return;
  }

  bricks.forEach((brick, index) => {
    const prefix = `bricks[${index}]`;
    if (!isPlainObject(brick)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    requireString(brick.id, `${prefix}.id`, errors);
    validatePoint(brick, prefix, grid, errors);
  });
}

function validateLootZones(lootZones, grid, errors) {
  if (!Array.isArray(lootZones)) {
    errors.push('lootZones must be an array');
    return;
  }

  lootZones.forEach((zone, index) => {
    const prefix = `lootZones[${index}]`;
    if (!isPlainObject(zone)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    requireString(zone.id, `${prefix}.id`, errors);
    validatePoint(zone, prefix, grid, errors);

    if (typeof zone.type !== 'string' || !ITEM_TYPES.has(zone.type)) {
      errors.push(`${prefix}.type must be one of: ${Array.from(ITEM_TYPES).join(', ')}`);
    }
  });
}

function validateToggles(toggles, errors) {
  if (!isPlainObject(toggles)) {
    errors.push('toggles must be an object');
    return;
  }

  if (typeof toggles.speedBoost !== 'boolean') {
    errors.push('toggles.speedBoost must be a boolean');
  }
}

function validatePoint(point, path, grid, errors) {
  if (!isPlainObject(point)) {
    errors.push(`${path} must be an object`);
    return;
  }

  requireInteger(point.x, `${path}.x`, errors);
  requireInteger(point.y, `${path}.y`, errors);

  if (isPlainObject(grid) && Number.isInteger(grid.cols) && Number.isInteger(grid.rows) && !isGridPoint(point, grid)) {
    errors.push(`${path} must be inside the grid`);
  }
}

function isGridPoint(point, grid) {
  return Number.isInteger(point.x)
    && Number.isInteger(point.y)
    && point.x >= 0
    && point.y >= 0
    && point.x < grid.cols
    && point.y < grid.rows;
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path} must be a non-empty string`);
  }
}

function requireNumber(value, path, errors) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${path} must be a number`);
  }
}

function requireInteger(value, path, errors) {
  if (!Number.isInteger(value)) {
    errors.push(`${path} must be an integer`);
  }
}

function requireIsoDate(value, path, errors) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    errors.push(`${path} must be an ISO timestamp string`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
