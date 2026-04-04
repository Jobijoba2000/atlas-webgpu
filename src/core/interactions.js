import * as d3 from 'd3';
import { gpuCanvas as webglCanvas } from './gpuContext.js';
import { isOrthographic, zoomState, orthoRotate } from './camera.js';
import { width, height } from './gpuContext.js';
import { mapState } from '../state/mapState.js';
import { appState } from '../state/appState.js';
import { getProjectionById } from '../config/projections.js';

export function speakText(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.1;
        window.speechSynthesis.speak(utterance);
    }
}

export function setupInteractions({ updateSize, redraw }) {
    window.addEventListener('resize', () => {
        updateSize();
        redraw();
    });
}
