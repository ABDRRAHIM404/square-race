import { startApp } from './ui/screens.js';
import { defaultMaze } from './mazes/default-maze.js';

const canvas = document.getElementById('gameCanvas');
startApp({ canvas, mazes: [defaultMaze] });
