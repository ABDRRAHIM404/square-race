import { playSound } from '../audio.js';
import { validateMaze } from '../engine/mazeFormat.js';
import { renderMaze, renderRaceOverlays, renderRacers } from '../engine/renderer.js';
import { createRace, updateRace } from '../engine/race.js';
import { RACER_COLORS } from '../engine/physics.js';
import { renderRaceHud } from './hud.js';
import { deleteMaze, downloadJson, exportAllMazes, exportMaze, generateMazeThumbnail, importMazeJson, listMazes, saveMaze } from '../storage/mazeStorage.js';
import { showMazeEditor } from '../editor/editor.js';

const POINTS_BY_PLACEMENT = new Map([
  [1, 4],
  [2, 3],
  [3, 2],
  [4, 1]
]);

export function startApp({ canvas, mazes }) {
  const overlay = document.createElement('div');
  overlay.id = 'screenOverlay';
  overlay.className = 'screen-overlay';
  document.querySelector('.app-shell').appendChild(overlay);

  const hud = document.createElement('div');
  hud.id = 'hudRoot';
  document.querySelector('.app-shell').appendChild(hud);

  const app = {
    canvas,
    overlay,
    hud,
    builtInMazes: mazes,
    mazes,
    selectedRacerId: null,
    selectedColor: null,
    stageIndex: 0,
    scores: RACER_COLORS.map((racer) => ({ id: racer.id, color: racer.color, points: 0 })),
    race: null,
    animationFrame: null,
    lastTime: 0,
    committedStageKey: null,
    seenPlacementCount: 0,
    hitStopUntil: 0
  };

  showTitle(app);
}

function showTitle(app) {
  stopRaceLoop(app);
  clearCanvas(app.canvas);
  app.hud.innerHTML = '';
  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel title-panel">
      <h1>Maze Runners</h1>
      <p>Pick a square. Watch the race.</p>
      <p class="tap-hint">Tap anywhere to start</p>
    </section>
  `;

  app.overlay.onclick = () => {
    playSound('tap');
    showSelect(app);
  };
}

function showSelect(app) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  app.overlay.onclick = null;
  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel select-panel">
      <h2>Choose your square</h2>
      <div class="racer-picker"></div>
      <button class="primary-button" type="button" disabled>START</button>
    </section>
  `;

  const picker = app.overlay.querySelector('.racer-picker');
  const startButton = app.overlay.querySelector('.primary-button');

  RACER_COLORS.forEach((racer) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'racer-choice';
    button.style.background = racer.color;
    button.setAttribute('aria-label', `Choose ${racer.id}`);
    button.textContent = racer.id;
    button.addEventListener('click', () => {
      playSound('tap');
      app.selectedRacerId = racer.id;
      app.selectedColor = racer.color;
      picker.querySelectorAll('.racer-choice').forEach((choice) => choice.classList.remove('selected'));
      button.classList.add('selected');
      startButton.disabled = false;
    });
    picker.appendChild(button);
  });

  startButton.addEventListener('click', () => {
    playSound('tap');
    showMazeLibrary(app);
  });
}

function startSession(app, selectedMazes = app.mazes) {
  app.mazes = selectedMazes;
  app.stageIndex = 0;
  app.scores = RACER_COLORS.map((racer) => ({ id: racer.id, color: racer.color, points: 0 }));
  app.committedStageKey = null;
  showStageIntro(app);
}


function showMazeLibrary(app) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  clearCanvas(app.canvas);

  const savedMazes = safeListSavedMazes();
  const libraryMazes = [
    ...app.builtInMazes.map((maze) => ({ maze, builtIn: true })),
    ...savedMazes.map((maze) => ({ maze, builtIn: false }))
  ];

  app.overlay.onclick = null;
  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel library-panel">
      <h2>Maze Library</h2>
      <p class="library-help">Choose one or more mazes for this session.</p>
      <div class="maze-list"></div>
      <div class="button-row">
        <button class="secondary-button create-maze-button" type="button">Create Maze</button>
        <button class="secondary-button save-default-button" type="button">Save Default Copy</button>
        <button class="secondary-button export-all-button" type="button">Export All</button>
      </div>
      <details class="import-box">
        <summary>Import JSON</summary>
        <textarea placeholder="Paste maze JSON here"></textarea>
        <button class="secondary-button import-button" type="button">Import</button>
      </details>
      <button class="primary-button start-session-button" type="button">Start Session</button>
      <p class="library-message" role="status"></p>
    </section>
  `;

  const list = app.overlay.querySelector('.maze-list');
  const message = app.overlay.querySelector('.library-message');
  const selectedIds = new Set(libraryMazes.length ? [mazeLibraryId(libraryMazes[0])] : []);

  function renderList() {
    list.innerHTML = '';
    const currentSavedMazes = safeListSavedMazes();
    const currentLibraryMazes = [
      ...app.builtInMazes.map((maze) => ({ maze, builtIn: true })),
      ...currentSavedMazes.map((maze) => ({ maze, builtIn: false }))
    ];

    currentLibraryMazes.forEach((entry) => {
      const id = mazeLibraryId(entry);
      const row = document.createElement('label');
      row.className = 'maze-row';
      row.innerHTML = `
        <input type="checkbox" ${selectedIds.has(id) ? 'checked' : ''}>
        <img class="maze-thumb" src="${entry.maze.thumbnail || generateMazeThumbnail(entry.maze)}" alt="">
        <span><strong>${escapeHtml(entry.maze.name)}</strong><small>${entry.builtIn ? 'Built-in' : 'Saved'}</small></span>
        <span class="maze-actions"></span>
      `;

      const checkbox = row.querySelector('input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(id);
        else selectedIds.delete(id);
      });

      const actions = row.querySelector('.maze-actions');
      const cloneButton = miniButton('Clone');
      cloneButton.addEventListener('click', (event) => {
        event.preventDefault();
        playSound('tap');
        showMazeEditor({
          overlay: app.overlay,
          canvas: app.canvas,
          sourceMaze: entry.maze,
          onSaved: () => showMazeLibrary(app),
          onCancel: () => showMazeLibrary(app),
          onTestPlay: (maze, returnToEditor) => startEditorTestPlay(app, maze, returnToEditor)
        });
      });
      actions.append(cloneButton);

      if (!entry.builtIn) {
        const exportButton = miniButton('Export');
        exportButton.addEventListener('click', (event) => {
          event.preventDefault();
          playSound('tap');
          downloadJson(`${entry.maze.id}.json`, exportMaze(entry.maze.id));
        });

        const deleteButton = miniButton('Delete');
        deleteButton.addEventListener('click', (event) => {
          event.preventDefault();
          playSound('tap');
          deleteMaze(entry.maze.id);
          selectedIds.delete(id);
          renderList();
        });

        actions.append(exportButton, deleteButton);
      }

      list.appendChild(row);
    });
  }

  renderList();

  app.overlay.querySelector('.create-maze-button').addEventListener('click', () => {
    playSound('tap');
    showMazeEditor({
      overlay: app.overlay,
      canvas: app.canvas,
      onSaved: () => showMazeLibrary(app),
      onCancel: () => showMazeLibrary(app),
      onTestPlay: (maze, returnToEditor) => startEditorTestPlay(app, maze, returnToEditor)
    });
  });

  app.overlay.querySelector('.save-default-button').addEventListener('click', () => {
    try {
      playSound('tap');
      const now = new Date().toISOString();
      const source = app.builtInMazes[0];
      saveMaze({
        ...JSON.parse(JSON.stringify(source)),
        id: `saved-${source.id}-${Date.now().toString(36)}`,
        name: `${source.name} Saved Copy`,
        createdAt: now,
        modifiedAt: now
      });
      message.textContent = 'Saved a copy of the default maze.';
      renderList();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  app.overlay.querySelector('.export-all-button').addEventListener('click', () => {
    try {
      playSound('tap');
      downloadJson('maze-runners-mazes.json', exportAllMazes());
      message.textContent = 'Export started.';
    } catch (error) {
      message.textContent = error.message;
    }
  });

  app.overlay.querySelector('.import-button').addEventListener('click', () => {
    try {
      playSound('tap');
      const textarea = app.overlay.querySelector('.import-box textarea');
      importMazeJson(textarea.value);
      textarea.value = '';
      message.textContent = 'Import complete.';
      renderList();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  app.overlay.querySelector('.start-session-button').addEventListener('click', () => {
    const currentSavedMazes = safeListSavedMazes();
    const currentLibraryMazes = [
      ...app.builtInMazes.map((maze) => ({ maze, builtIn: true })),
      ...currentSavedMazes.map((maze) => ({ maze, builtIn: false }))
    ];
    const selectedMazes = currentLibraryMazes
      .filter((entry) => selectedIds.has(mazeLibraryId(entry)))
      .map((entry) => entry.maze);

    if (selectedMazes.length === 0) {
      message.textContent = 'Select at least one maze.';
      return;
    }

    playSound('tap');
    startSession(app, selectedMazes);
  });
}

function showStageIntro(app) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  const maze = app.mazes[app.stageIndex];
  validateOrThrow(maze);
  renderMaze(app.canvas, maze);

  app.overlay.onclick = null;
  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel intro-panel">
      <p class="stage-label">Stage ${app.stageIndex + 1} / ${app.mazes.length}</p>
      <h2>${escapeHtml(maze.name)}</h2>
      <p class="countdown">3</p>
    </section>
  `;

  let count = 3;
  const countdown = app.overlay.querySelector('.countdown');
  const timer = window.setInterval(() => {
    count -= 1;
    if (count <= 0) {
      window.clearInterval(timer);
      startRace(app, maze);
    } else {
      countdown.textContent = String(count);
      playSound('tap');
    }
  }, 650);
}

function startRace(app, maze) {
  app.overlay.className = 'screen-overlay hidden';
  app.overlay.innerHTML = '';
  app.race = createRace(maze);
  app.lastTime = performance.now();
  app.seenPlacementCount = 0;
  app.hitStopUntil = 0;
  renderRaceHud(app.hud, app.scores, app.selectedRacerId);
  app.animationFrame = requestAnimationFrame((now) => raceFrame(app, now));
}

function raceFrame(app, now) {
  if (now < app.hitStopUntil) {
    app.lastTime = now;
    drawRace(app);
    app.animationFrame = requestAnimationFrame((nextNow) => raceFrame(app, nextNow));
    return;
  }

  const deltaTime = Math.min(0.05, (now - app.lastTime) / 1000);
  app.lastTime = now;

  const previousPositions = app.race.racers.map((racer) => ({ id: racer.id, vx: racer.vx, vy: racer.vy }));
  updateRace(app.race, deltaTime);
  playRaceEvents(app, previousPositions, now);
  drawRace(app);

  if (app.race.complete) {
    app.animationFrame = null;
    window.setTimeout(() => showStageResult(app), 450);
    return;
  }

  app.animationFrame = requestAnimationFrame((nextNow) => raceFrame(app, nextNow));
}

function playRaceEvents(app, previousPositions, now = performance.now()) {
  if (app.race.placements.length > app.seenPlacementCount) {
    const newPlacements = app.race.placements.slice(app.seenPlacementCount);
    newPlacements.forEach((placement) => playSound(placement.status === 'eliminated' ? 'eliminate' : 'finish'));
    app.seenPlacementCount = app.race.placements.length;
    app.hitStopUntil = Math.max(app.hitStopUntil, now + 300);
    return;
  }

  const bounced = app.race.racers.some((racer, index) => {
    const before = previousPositions[index];
    return before && !racer.finished && !racer.eliminated
      && (Math.sign(before.vx) !== Math.sign(racer.vx) || Math.sign(before.vy) !== Math.sign(racer.vy));
  });

  if (bounced && Math.random() < 0.08) {
    playSound('collision');
  }
}

function drawRace(app) {
  const maze = app.mazes[app.stageIndex];
  renderMaze(app.canvas, maze, { drawDynamicMarkers: false });
  renderRaceOverlays(app.canvas, maze, app.race);
  renderRacers(app.canvas, maze, app.race.racers);
}


function startEditorTestPlay(app, maze, returnToEditor) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  app.overlay.className = 'screen-overlay hidden';
  app.overlay.innerHTML = '';
  app.race = createRace(maze);
  app.lastTime = performance.now();
  app.seenPlacementCount = 0;
  app.hitStopUntil = 0;
  app.editorTestReturn = returnToEditor;
  app.editorTestMaze = maze;
  app.animationFrame = requestAnimationFrame((now) => editorTestFrame(app, now));
}

function editorTestFrame(app, now) {
  if (now < app.hitStopUntil) {
    app.lastTime = now;
    renderMaze(app.canvas, app.editorTestMaze, { drawDynamicMarkers: false });
    renderRaceOverlays(app.canvas, app.editorTestMaze, app.race);
    renderRacers(app.canvas, app.editorTestMaze, app.race.racers);
    app.animationFrame = requestAnimationFrame((nextNow) => editorTestFrame(app, nextNow));
    return;
  }

  const deltaTime = Math.min(0.05, (now - app.lastTime) / 1000);
  app.lastTime = now;
  updateRace(app.race, deltaTime);
  playRaceEvents(app, [], now);
  renderMaze(app.canvas, app.editorTestMaze, { drawDynamicMarkers: false });
  renderRaceOverlays(app.canvas, app.editorTestMaze, app.race);
  renderRacers(app.canvas, app.editorTestMaze, app.race.racers);

  if (app.race.complete) {
    app.animationFrame = null;
    showEditorTestResult(app);
    return;
  }

  app.animationFrame = requestAnimationFrame((nextNow) => editorTestFrame(app, nextNow));
}

function showEditorTestResult(app) {
  const placements = sortedPlacements(app.race.placements);
  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel result-panel">
      <h2>Test-Play Complete</h2>
      <ol class="placement-list">
        ${placements.map((placement) => `<li><span>${placement.placement}. ${placement.racerId}</span><strong>${placement.status}</strong></li>`).join('')}
      </ol>
      <button class="primary-button back-editor-button" type="button">Back to Editor</button>
    </section>
  `;
  app.overlay.querySelector('.back-editor-button').addEventListener('click', () => {
    playSound('tap');
    app.editorTestReturn?.();
  });
}

function showStageResult(app) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  const placements = sortedPlacements(app.race.placements);
  const points = placements.map((placement) => ({
    ...placement,
    points: POINTS_BY_PLACEMENT.get(placement.placement) || 0
  }));

  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel result-panel">
      <h2>Stage Result</h2>
      <ol class="placement-list">
        ${points.map((placement) => `<li><span>${placement.placement}. ${placement.racerId}</span><strong>+${placement.points}</strong></li>`).join('')}
      </ol>
      <div class="button-row">
        <button class="secondary-button restart-button" type="button">Quick-Restart</button>
        <button class="primary-button continue-button" type="button">${app.stageIndex + 1 >= app.mazes.length ? 'Final Result' : 'Next Maze'}</button>
      </div>
    </section>
  `;

  app.overlay.querySelector('.restart-button').addEventListener('click', () => {
    playSound('tap');
    showStageIntro(app);
  });

  app.overlay.querySelector('.continue-button').addEventListener('click', () => {
    playSound('tap');
    commitStageScore(app, points);
    if (app.stageIndex + 1 >= app.mazes.length) {
      showFinalResult(app);
    } else {
      app.stageIndex += 1;
      app.committedStageKey = null;
      showStageIntro(app);
    }
  });
}

function commitStageScore(app, points) {
  const stageKey = `${app.stageIndex}:${app.race.elapsed.toFixed(3)}:${app.race.placements.map((placement) => placement.racerId).join(',')}`;
  if (app.committedStageKey === stageKey) return;

  points.forEach((placement) => {
    const score = app.scores.find((candidate) => candidate.id === placement.racerId);
    if (score) score.points += placement.points;
  });

  app.committedStageKey = stageKey;
}

function showFinalResult(app) {
  stopRaceLoop(app);
  app.hud.innerHTML = '';
  const podium = [...app.scores].sort((a, b) => b.points - a.points);

  app.overlay.className = 'screen-overlay screen-centered';
  app.overlay.innerHTML = `
    <section class="panel final-panel">
      <h2>Final Podium</h2>
      <ol class="placement-list podium-list">
        ${podium.map((score, index) => `<li><span>${index + 1}. ${score.id}</span><strong>${score.points}</strong></li>`).join('')}
      </ol>
      <div class="button-row">
        <button class="secondary-button change-button" type="button">Change Square</button>
        <button class="primary-button again-button" type="button">Play Again</button>
      </div>
    </section>
  `;

  app.overlay.querySelector('.again-button').addEventListener('click', () => {
    playSound('tap');
    startSession(app);
  });

  app.overlay.querySelector('.change-button').addEventListener('click', () => {
    playSound('tap');
    showSelect(app);
  });
}


function safeListSavedMazes() {
  try {
    return listMazes();
  } catch (_error) {
    return [];
  }
}

function mazeLibraryId(entry) {
  return `${entry.builtIn ? 'built-in' : 'saved'}:${entry.maze.id}`;
}

function miniButton(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini-button';
  button.textContent = label;
  return button;
}

function stopRaceLoop(app) {
  if (app.animationFrame !== null) {
    cancelAnimationFrame(app.animationFrame);
    app.animationFrame = null;
  }
}

function sortedPlacements(placements) {
  return [...placements].sort((a, b) => a.placement - b.placement);
}

function validateOrThrow(maze) {
  const validation = validateMaze(maze);
  if (!validation.valid) {
    throw new Error(`Maze is invalid:\n${validation.errors.join('\n')}`);
  }
}

function clearCanvas(canvas) {
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  context.fillStyle = '#0f172a';
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
