import { validateMaze } from '../engine/mazeFormat.js';

const PREFIX = 'maze_';

export function saveMaze(maze) {
  assertStorageAvailable();
  const validation = validateMaze(maze);
  if (!validation.valid) {
    throw new Error(`Cannot save invalid maze:\n${validation.errors.join('\n')}`);
  }

  const storedMaze = { ...maze };
  if (!storedMaze.thumbnail) {
    storedMaze.thumbnail = generateMazeThumbnail(storedMaze);
  }

  localStorage.setItem(storageKey(storedMaze.id), JSON.stringify(storedMaze));
  return storedMaze;
}

export function loadMaze(id) {
  assertStorageAvailable();
  const raw = localStorage.getItem(storageKey(id));
  if (!raw) return null;

  const maze = JSON.parse(raw);
  const validation = validateMaze(maze);
  if (!validation.valid) {
    throw new Error(`Stored maze ${id} is invalid:\n${validation.errors.join('\n')}`);
  }

  return maze;
}

export function listMazes() {
  assertStorageAvailable();
  const mazes = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(PREFIX)) continue;

    const raw = localStorage.getItem(key);
    if (!raw) continue;

    const maze = JSON.parse(raw);
    const validation = validateMaze(maze);
    if (validation.valid) mazes.push(maze);
  }

  return mazes.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteMaze(id) {
  assertStorageAvailable();
  localStorage.removeItem(storageKey(id));
}

export function duplicateMaze(id, name = null) {
  const source = loadMaze(id);
  if (!source) throw new Error(`Maze not found: ${id}`);

  const now = new Date().toISOString();
  const copy = {
    ...structuredCloneFallback(source),
    id: makeMazeId(),
    name: name || `${source.name} Copy`,
    createdAt: now,
    modifiedAt: now,
    thumbnail: null
  };

  return saveMaze(copy);
}

export function exportMaze(id) {
  const maze = loadMaze(id);
  if (!maze) throw new Error(`Maze not found: ${id}`);
  return JSON.stringify(maze, null, 2);
}

export function exportAllMazes() {
  return JSON.stringify({ mazes: listMazes() }, null, 2);
}

export function importMazeJson(jsonText, options = {}) {
  const parsed = JSON.parse(jsonText);

  if (Array.isArray(parsed.mazes)) {
    return parsed.mazes.map((maze) => importMazeObject(maze, options));
  }

  return importMazeObject(parsed, options);
}

export function downloadJson(filename, jsonText) {
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function generateMazeThumbnail(maze) {
  const cell = 4;
  const width = maze.grid.cols * cell;
  const height = maze.grid.rows * cell;
  const open = new Set(maze.corridor.cells.map((cellData) => `${cellData.x},${cellData.y}`));
  const rects = maze.corridor.cells
    .map((cellData) => `<rect x="${cellData.x * cell}" y="${cellData.y * cell}" width="${cell}" height="${cell}" fill="%23f8fafc"/>`)
    .join('');
  const walls = maze.corridor.cells
    .flatMap((cellData) => {
      const x = cellData.x * cell;
      const y = cellData.y * cell;
      const edges = [];
      if (!open.has(`${cellData.x},${cellData.y - 1}`)) edges.push(`<path d="M${x} ${y}h${cell}"/>`);
      if (!open.has(`${cellData.x + 1},${cellData.y}`)) edges.push(`<path d="M${x + cell} ${y}v${cell}"/>`);
      if (!open.has(`${cellData.x},${cellData.y + 1}`)) edges.push(`<path d="M${x} ${y + cell}h${cell}"/>`);
      if (!open.has(`${cellData.x - 1},${cellData.y}`)) edges.push(`<path d="M${x} ${y}v${cell}"/>`);
      return edges;
    })
    .join('');
  const start = `<rect x="${maze.start.x * cell}" y="${maze.start.y * cell}" width="${cell}" height="${cell}" fill="%2322c55e"/>`;
  const exit = `<rect x="${maze.exit.x * cell}" y="${maze.exit.y * cell}" width="${cell}" height="${cell}" fill="%23f97316"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="%230f172a"/>${rects}<g stroke="%231e293b" stroke-width="1" fill="none">${walls}</g>${start}${exit}</svg>`;
  return `data:image/svg+xml,${svg}`;
}

export function storageKey(id) {
  return `${PREFIX}${id}`;
}

export function makeMazeId() {
  return `maze-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function importMazeObject(maze, options) {
  const validation = validateMaze(maze);
  if (!validation.valid) {
    throw new Error(`Cannot import invalid maze:\n${validation.errors.join('\n')}`);
  }

  const replaceExisting = options.replaceExisting !== false;
  const imported = structuredCloneFallback(maze);

  if (!replaceExisting && localStorage.getItem(storageKey(imported.id))) {
    const now = new Date().toISOString();
    imported.id = makeMazeId();
    imported.name = `${imported.name} Import`;
    imported.createdAt = now;
    imported.modifiedAt = now;
  }

  if (!imported.thumbnail) imported.thumbnail = generateMazeThumbnail(imported);
  return saveMaze(imported);
}

function assertStorageAvailable() {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available');
  }
}

function structuredCloneFallback(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
