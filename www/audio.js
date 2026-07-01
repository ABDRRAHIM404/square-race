let audioContext = null;
let muted = false;

const SOUND = {
  tap: { frequency: 520, duration: 0.05, type: 'triangle', volume: 0.05 },
  finish: { frequency: 780, duration: 0.16, type: 'sine', volume: 0.07 },
  eliminate: { frequency: 140, duration: 0.18, type: 'sawtooth', volume: 0.06 },
  collision: { frequency: 220, duration: 0.035, type: 'square', volume: 0.025 }
};

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
}

export function toggleMuted() {
  muted = !muted;
  return muted;
}

export function playSound(name) {
  if (muted) return;

  const config = SOUND[name];
  if (!config) return;

  const context = getAudioContext();
  if (!context) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;

  oscillator.type = config.type;
  oscillator.frequency.setValueAtTime(config.frequency, now);
  gain.gain.setValueAtTime(config.volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + config.duration);
}

function getAudioContext() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    audioContext = new AudioCtor();
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  return audioContext;
}
