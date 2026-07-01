import { isMuted, toggleMuted } from '../audio.js';

export function renderRaceHud(root, scores, selectedRacerId, onMuteChanged) {
  root.innerHTML = '';
  root.className = 'hud hud-race';

  const scoreList = document.createElement('div');
  scoreList.className = 'hud-panel score-list';
  scores.forEach((score) => {
    const row = document.createElement('div');
    row.className = score.id === selectedRacerId ? 'score-row selected' : 'score-row';
    row.innerHTML = `<span class="score-dot" style="background:${score.color}"></span><span>${score.id}</span><strong>${score.points}</strong>`;
    scoreList.appendChild(row);
  });

  const muteButton = document.createElement('button');
  muteButton.className = 'hud-button';
  muteButton.type = 'button';
  muteButton.textContent = isMuted() ? 'Muted' : 'Sound';
  muteButton.addEventListener('click', () => {
    const muted = toggleMuted();
    muteButton.textContent = muted ? 'Muted' : 'Sound';
    onMuteChanged?.(muted);
  });

  root.append(scoreList, muteButton);
}
