import { cellKey, makeCellSet } from './mazeFormat.js';

const COLORS = {
  background: '#0f172a',
  grid: 'rgba(148, 163, 184, 0.13)',
  floor: '#f8fafc',
  floorShadow: '#dbeafe',
  wall: '#1e293b',
  wallHighlight: '#38bdf8',
  start: '#22c55e',
  exit: '#f97316',
  deadEnd: '#fde68a',
  brick: '#b45309',
  knife: '#e11d48',
  shield: '#2563eb',
  label: '#f8fafc'
};

export function renderMaze(canvas, maze) {
  const context = canvas.getContext('2d');
  const layout = resizeCanvas(canvas, maze.grid);
  const openCells = makeCellSet(maze.corridor.cells);
  const deadEndCells = makeCellSet(maze.deadEnds.flatMap((deadEnd) => deadEnd.cells));

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  drawGrid(context, maze.grid, layout);
  drawFloor(context, maze.corridor.cells, deadEndCells, layout);
  drawMarkers(context, maze, layout);
  drawWalls(context, maze, openCells, layout);
  drawTitle(context, maze.name, layout);

  return { context, layout };
}


export function renderRaceOverlays(canvas, maze, race) {
  const context = canvas.getContext('2d');
  const layout = currentLayout(canvas, maze.grid);

  if (race.options?.enablePursuingWall) {
    context.fillStyle = 'rgba(88, 28, 135, 0.58)';
    race.pursuingWall.filledCells.forEach((key) => {
      const [x, y] = key.split(',').map(Number);
      const rect = cellRect({ x, y }, layout);
      context.fillRect(rect.x, rect.y, rect.size, rect.size);
    });
  }

  race.bricks?.forEach((brick) => {
    if (brick.broken) return;
    const rect = insetRect(cellRect(brick, layout), 0.18);
    context.fillStyle = COLORS.brick;
    roundRect(context, rect.x, rect.y, rect.size, rect.size, rect.size * 0.12);
    context.fill();
  });

  race.loot?.forEach((zone) => {
    if (zone.pickedUp) return;
    const color = zone.type === 'knife' ? COLORS.knife : zone.type === 'shield' ? COLORS.shield : '#a855f7';
    const label = zone.type === 'knife' ? 'K' : zone.type === 'shield' ? 'H' : 'B';
    drawCellBadge(context, zone, layout, color, label, 0.52);
  });
}

export function renderRacers(canvas, maze, racers) {
  const context = canvas.getContext('2d');
  const layout = currentLayout(canvas, maze.grid);

  racers.forEach((racer) => {
    const size = racer.halfSize * 2 * layout.cell;
    const x = layout.offsetX + racer.x * layout.cell - size / 2;
    const y = layout.offsetY + racer.y * layout.cell - size / 2;

    context.globalAlpha = racer.finished || racer.eliminated ? 0.35 : 1;
    context.fillStyle = racer.color;
    roundRect(context, x, y, size, size, size * 0.12);
    context.fill();

    context.strokeStyle = '#0f172a';
    context.lineWidth = Math.max(1, layout.ratio * 2);
    context.stroke();
    context.globalAlpha = 1;
  });
}

export function currentLayout(canvas, grid) {
  return resizeCanvas(canvas, grid);
}

function resizeCanvas(canvas, grid) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const usableWidth = width * 0.88;
  const usableHeight = height * 0.84;
  const cell = Math.floor(Math.min(usableWidth / grid.cols, usableHeight / grid.rows));
  const boardWidth = cell * grid.cols;
  const boardHeight = cell * grid.rows;

  return {
    ratio,
    cell,
    boardWidth,
    boardHeight,
    offsetX: Math.floor((width - boardWidth) / 2),
    offsetY: Math.floor((height - boardHeight) / 2)
  };
}

function drawGrid(context, grid, layout) {
  context.strokeStyle = COLORS.grid;
  context.lineWidth = Math.max(1, layout.ratio);

  for (let x = 0; x <= grid.cols; x += 1) {
    const px = layout.offsetX + x * layout.cell;
    line(context, px, layout.offsetY, px, layout.offsetY + layout.boardHeight);
  }

  for (let y = 0; y <= grid.rows; y += 1) {
    const py = layout.offsetY + y * layout.cell;
    line(context, layout.offsetX, py, layout.offsetX + layout.boardWidth, py);
  }
}

function drawFloor(context, cells, deadEndCells, layout) {
  cells.forEach((cell) => {
    const rect = cellRect(cell, layout);
    context.fillStyle = deadEndCells.has(cellKey(cell.x, cell.y)) ? COLORS.deadEnd : COLORS.floor;
    context.fillRect(rect.x, rect.y, rect.size, rect.size);

    context.fillStyle = COLORS.floorShadow;
    context.globalAlpha = 0.28;
    context.fillRect(rect.x, rect.y + rect.size * 0.72, rect.size, rect.size * 0.28);
    context.globalAlpha = 1;
  });
}

function drawMarkers(context, maze, layout) {
  drawCellBadge(context, maze.start, layout, COLORS.start, 'S');
  drawCellBadge(context, maze.exit, layout, COLORS.exit, 'E');

  maze.lootZones.forEach((zone) => {
    const color = zone.type === 'knife' ? COLORS.knife : zone.type === 'shield' ? COLORS.shield : '#a855f7';
    const label = zone.type === 'knife' ? 'K' : zone.type === 'shield' ? 'H' : 'B';
    drawCellBadge(context, zone, layout, color, label, 0.52);
  });

  maze.bricks.forEach((brick) => {
    const rect = insetRect(cellRect(brick, layout), 0.18);
    context.fillStyle = COLORS.brick;
    roundRect(context, rect.x, rect.y, rect.size, rect.size, rect.size * 0.12);
    context.fill();
  });
}

function drawWalls(context, maze, openCells, layout) {
  context.strokeStyle = COLORS.wall;
  context.lineWidth = Math.max(4 * layout.ratio, layout.cell * 0.13);
  context.lineCap = 'round';
  context.lineJoin = 'round';

  maze.corridor.cells.forEach((cell) => {
    const rect = cellRect(cell, layout);
    const neighbors = [
      { dx: 0, dy: -1, x1: rect.x, y1: rect.y, x2: rect.x + rect.size, y2: rect.y },
      { dx: 1, dy: 0, x1: rect.x + rect.size, y1: rect.y, x2: rect.x + rect.size, y2: rect.y + rect.size },
      { dx: 0, dy: 1, x1: rect.x, y1: rect.y + rect.size, x2: rect.x + rect.size, y2: rect.y + rect.size },
      { dx: -1, dy: 0, x1: rect.x, y1: rect.y, x2: rect.x, y2: rect.y + rect.size }
    ];

    neighbors.forEach((edge) => {
      if (!openCells.has(cellKey(cell.x + edge.dx, cell.y + edge.dy))) {
        line(context, edge.x1, edge.y1, edge.x2, edge.y2);
      }
    });
  });

  context.strokeStyle = COLORS.wallHighlight;
  context.lineWidth = Math.max(1 * layout.ratio, layout.cell * 0.025);
  context.globalAlpha = 0.55;
  context.strokeRect(layout.offsetX, layout.offsetY, layout.boardWidth, layout.boardHeight);
  context.globalAlpha = 1;
}

function drawCellBadge(context, cell, layout, color, text, scale = 0.7) {
  const rect = cellRect(cell, layout);
  const size = rect.size * scale;
  const x = rect.x + (rect.size - size) / 2;
  const y = rect.y + (rect.size - size) / 2;

  context.fillStyle = color;
  roundRect(context, x, y, size, size, size * 0.18);
  context.fill();

  context.fillStyle = COLORS.label;
  context.font = `700 ${Math.max(10, Math.floor(size * 0.5))}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, x + size / 2, y + size / 2 + size * 0.03);
}

function drawTitle(context, title, layout) {
  context.fillStyle = COLORS.label;
  context.font = `700 ${Math.max(16, Math.floor(18 * layout.ratio))}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillText(title, layout.offsetX + layout.boardWidth / 2, Math.max(8 * layout.ratio, layout.offsetY * 0.35));
}

function cellRect(cell, layout) {
  return {
    x: layout.offsetX + cell.x * layout.cell,
    y: layout.offsetY + cell.y * layout.cell,
    size: layout.cell
  };
}

function insetRect(rect, ratio) {
  const inset = rect.size * ratio;
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    size: rect.size - inset * 2
  };
}

function line(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}
