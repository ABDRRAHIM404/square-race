import { makeMazeId, saveMaze } from '../storage/mazeStorage.js';
import { cellKey, makeCellSet, validateMaze } from '../engine/mazeFormat.js';
import { currentLayout, renderMaze } from '../engine/renderer.js';

const TOOLS = [
  { id: 'corridor', label: 'Corridor' },
  { id: 'erase', label: 'Erase' },
  { id: 'start', label: 'Start' },
  { id: 'exit', label: 'Exit' },
  { id: 'deadEnd', label: 'Dead End' },
  { id: 'brick', label: 'Brick' },
  { id: 'knife', label: 'Knife' },
  { id: 'shield', label: 'Shield' },
  { id: 'speedBoost', label: 'Boost' }
];

const GRID = { cols: 15, rows: 27, cellSize: 24 };
const NOW_FALLBACK = '2026-07-01T00:00:00.000Z';

export function showMazeEditor({ overlay, canvas, onSaved, onCancel, sourceMaze = null, onTestPlay }) {
  document.body?.classList.add('editor-open');
  const draft = sourceMaze ? mazeToDraft(sourceMaze) : createBlankMazeDraft();
  let activeTool = 'corridor';
  let drawing = false;

  overlay.onclick = null;
  overlay.className = 'screen-overlay editor-overlay';
  overlay.innerHTML = `
    <section class="editor-panel">
      <div class="editor-header">
        <h2>Maze Editor</h2>
        <input class="maze-name-input" value="New Maze" aria-label="Maze name">
      </div>
      <div class="tool-grid"></div>
      <p class="editor-help">Draw corridor cells on the canvas. Set start, exit, dead ends, bricks, knife and shield zones.</p>
      <label class="boost-toggle"><input type="checkbox" class="speed-boost-toggle"> Enable speed boost</label>
      <p class="editor-estimate"></p>
      <p class="editor-message" role="status"></p>
      <div class="button-row">
        <button class="secondary-button test-play-button" type="button">Test-Play</button>
        <button class="secondary-button cancel-editor-button" type="button">Cancel</button>
        <button class="primary-button save-editor-button" type="button">Save Maze</button>
      </div>
    </section>
  `;

  const toolGrid = overlay.querySelector('.tool-grid');
  const message = overlay.querySelector('.editor-message');
  const estimate = overlay.querySelector('.editor-estimate');
  const boostToggle = overlay.querySelector('.speed-boost-toggle');
  if (!boostToggle) throw new Error('Speed boost toggle failed to render');
  boostToggle.checked = draft.speedBoost;
  TOOLS.forEach((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = tool.id === activeTool ? 'tool-button active' : 'tool-button';
    button.textContent = tool.label;
    button.addEventListener('click', () => {
      activeTool = tool.id;
      toolGrid.querySelectorAll('.tool-button').forEach((candidate) => candidate.classList.remove('active'));
      button.classList.add('active');
    });
    toolGrid.appendChild(button);
  });

  function redraw() {
    draft.speedBoost = boostToggle.checked;
    const maze = draftToMaze(draft, overlay.querySelector('.maze-name-input').value);
    estimate.textContent = `Estimated time: ${estimateMazeTime(maze)}s`;
    renderMaze(canvas, maze);
  }

  function applyPointer(event) {
    const cell = eventToCell(canvas, draft.grid, event);
    if (!cell) return;
    applyTool(draft, activeTool, cell);
    const maze = draftToMaze(draft, overlay.querySelector('.maze-name-input').value);
    const path = validateMazePath(maze);
    message.textContent = path.valid ? 'Path OK.' : path.errors[0];
    redraw();
  }

  boostToggle.addEventListener('change', redraw);

  canvas.onpointerdown = (event) => {
    drawing = true;
    canvas.setPointerCapture?.(event.pointerId);
    applyPointer(event);
  };

  canvas.onpointermove = (event) => {
    if (drawing && (activeTool === 'corridor' || activeTool === 'erase' || activeTool === 'deadEnd')) {
      applyPointer(event);
    }
  };

  canvas.onpointerup = (event) => {
    drawing = false;
    canvas.releasePointerCapture?.(event.pointerId);
  };

  canvas.onpointercancel = () => {
    drawing = false;
  };

  overlay.querySelector('.cancel-editor-button').addEventListener('click', () => {
    clearCanvasHandlers(canvas);
    onCancel?.();
  });

  overlay.querySelector('.test-play-button').addEventListener('click', () => {
    try {
      draft.speedBoost = boostToggle.checked;
      const maze = draftToMaze(draft, overlay.querySelector('.maze-name-input').value);
      const path = validateMazePath(maze);
      if (!path.valid) throw new Error(path.errors[0]);
      clearCanvasHandlers(canvas);
      onTestPlay?.(maze, () => showMazeEditor({ overlay, canvas, onSaved, onCancel, sourceMaze: maze, onTestPlay }));
    } catch (error) {
      message.textContent = error.message;
    }
  });

  overlay.querySelector('.save-editor-button').addEventListener('click', () => {
    try {
      draft.speedBoost = boostToggle.checked;
      const maze = draftToMaze(draft, overlay.querySelector('.maze-name-input').value);
      const validation = validateMaze(maze);
      if (!validation.valid) throw new Error(validation.errors[0]);

      const path = validateMazePath(maze);
      if (!path.valid) throw new Error(path.errors[0]);

      saveMaze(maze);
      clearCanvasHandlers(canvas);
      onSaved?.(maze);
    } catch (error) {
      message.textContent = error.message;
    }
  });

  redraw();
}

export function createBlankMazeDraft() {
  const corridor = new Set();
  for (let y = 22; y <= 24; y += 1) {
    for (let x = 6; x <= 8; x += 1) corridor.add(cellKey(x, y));
  }

  return {
    id: makeMazeId(),
    grid: { ...GRID },
    corridor,
    start: { x: 7, y: 23 },
    exit: { x: 7, y: 22 },
    deadEndCells: new Set(),
    bricks: new Set(),
    lootZones: [],
    speedBoost: false
  };
}

export function applyTool(draft, tool, cell) {
  const key = cellKey(cell.x, cell.y);

  if (tool === 'corridor') {
    draft.corridor.add(key);
    return;
  }

  if (tool === 'erase') {
    draft.corridor.delete(key);
    draft.deadEndCells.delete(key);
    draft.bricks.delete(key);
    draft.lootZones = draft.lootZones.filter((zone) => zone.x !== cell.x || zone.y !== cell.y);
    return;
  }

  draft.corridor.add(key);

  if (tool === 'start') {
    draft.start = { ...cell };
  } else if (tool === 'exit') {
    draft.exit = { ...cell };
  } else if (tool === 'deadEnd') {
    if (draft.deadEndCells.has(key)) draft.deadEndCells.delete(key);
    else draft.deadEndCells.add(key);
  } else if (tool === 'brick') {
    if (draft.bricks.has(key)) draft.bricks.delete(key);
    else draft.bricks.add(key);
  } else if (tool === 'knife' || tool === 'shield' || tool === 'speedBoost') {
    draft.lootZones = draft.lootZones.filter((zone) => zone.type !== tool);
    draft.lootZones.push({ id: `${tool}-zone`, type: tool, x: cell.x, y: cell.y });
    if (tool === 'speedBoost') draft.speedBoost = true;
  }
}

export function draftToMaze(draft, name = 'New Maze') {
  const now = new Date().toISOString?.() || NOW_FALLBACK;
  const corridorCells = setToCells(draft.corridor);
  const deadEndCells = setToCells(draft.deadEndCells).filter((cell) => draft.corridor.has(cellKey(cell.x, cell.y)));
  const mouth = findDeadEndMouth(draft, deadEndCells);

  return {
    schemaVersion: 1,
    id: draft.id,
    name: name.trim() || 'New Maze',
    createdAt: now,
    modifiedAt: now,
    grid: { ...draft.grid },
    corridor: { cells: corridorCells },
    start: { ...draft.start },
    exit: { ...draft.exit },
    deadEnds: deadEndCells.length && mouth ? [{ id: 'dead-end-1', mouth, cells: deadEndCells }] : [],
    bricks: setToCells(draft.bricks)
      .filter((cell) => draft.corridor.has(cellKey(cell.x, cell.y)))
      .map((cell, index) => ({ id: `brick-${index + 1}`, ...cell })),
    lootZones: draft.lootZones.filter((zone) => draft.corridor.has(cellKey(zone.x, zone.y))),
    toggles: { speedBoost: draft.speedBoost }
  };
}

export function validateMazePath(maze) {
  const errors = [];
  const validation = validateMaze(maze);
  if (!validation.valid) return validation;

  const open = makeCellSet(maze.corridor.cells);
  const startKey = cellKey(maze.start.x, maze.start.y);
  const exitKey = cellKey(maze.exit.x, maze.exit.y);

  if (!open.has(startKey)) errors.push('Start must be on a corridor cell.');
  if (!open.has(exitKey)) errors.push('Exit must be on a corridor cell.');

  maze.lootZones.forEach((zone) => {
    const distance = Math.abs(zone.x - maze.exit.x) + Math.abs(zone.y - maze.exit.y);
    if (distance < 2 || distance > 8) {
      errors.push(`${zone.type} must be near the exit but not adjacent to it.`);
    }
  });

  if (errors.length) return { valid: false, errors };

  const queue = [maze.start];
  const visited = new Set([startKey]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (cellKey(current.x, current.y) === exitKey) return { valid: true, errors: [] };

    neighbors(current).forEach((neighbor) => {
      const key = cellKey(neighbor.x, neighbor.y);
      if (open.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(neighbor);
      }
    });
  }

  return { valid: false, errors: ['No valid corridor path from start to exit.'] };
}


export function mazeToDraft(maze) {
  return {
    id: makeMazeId(),
    grid: { ...maze.grid },
    corridor: new Set(maze.corridor.cells.map((cell) => cellKey(cell.x, cell.y))),
    start: { ...maze.start },
    exit: { ...maze.exit },
    deadEndCells: new Set(maze.deadEnds.flatMap((deadEnd) => deadEnd.cells).map((cell) => cellKey(cell.x, cell.y))),
    bricks: new Set(maze.bricks.map((brick) => cellKey(brick.x, brick.y))),
    lootZones: maze.lootZones.map((zone) => ({ ...zone })),
    speedBoost: Boolean(maze.toggles.speedBoost)
  };
}

export function estimateMazeTime(maze) {
  const path = shortestPathLength(maze);
  if (!Number.isFinite(path)) return '—';
  const turnPenalty = Math.round(path * 0.35);
  return Math.max(5, Math.round((path + turnPenalty) / 2.4));
}

function shortestPathLength(maze) {
  const open = makeCellSet(maze.corridor.cells);
  const startKey = cellKey(maze.start.x, maze.start.y);
  const exitKey = cellKey(maze.exit.x, maze.exit.y);
  const queue = [{ ...maze.start, distance: 0 }];
  const visited = new Set([startKey]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (cellKey(current.x, current.y) === exitKey) return current.distance;
    neighbors(current).forEach((neighbor) => {
      const key = cellKey(neighbor.x, neighbor.y);
      if (open.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push({ ...neighbor, distance: current.distance + 1 });
      }
    });
  }

  return Infinity;
}

function eventToCell(canvas, grid, event) {
  const layout = currentLayout(canvas, grid);
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const x = (event.clientX - rect.left) * ratio;
  const y = (event.clientY - rect.top) * ratio;
  const cellX = Math.floor((x - layout.offsetX) / layout.cell);
  const cellY = Math.floor((y - layout.offsetY) / layout.cell);

  if (cellX < 0 || cellY < 0 || cellX >= grid.cols || cellY >= grid.rows) return null;
  return { x: cellX, y: cellY };
}

function findDeadEndMouth(draft, deadEndCells) {
  const deadSet = new Set(deadEndCells.map((cell) => cellKey(cell.x, cell.y)));
  for (const cell of deadEndCells) {
    const mouth = neighbors(cell).find((neighbor) => {
      const key = cellKey(neighbor.x, neighbor.y);
      return draft.corridor.has(key) && !deadSet.has(key);
    });
    if (mouth) return mouth;
  }
  return null;
}

function setToCells(set) {
  return [...set]
    .map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function neighbors(cell) {
  return [
    { x: cell.x + 1, y: cell.y },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x, y: cell.y - 1 }
  ];
}

function clearCanvasHandlers(canvas) {
  document.body?.classList.remove('editor-open');
  canvas.onpointerdown = null;
  canvas.onpointermove = null;
  canvas.onpointerup = null;
  canvas.onpointercancel = null;
}
