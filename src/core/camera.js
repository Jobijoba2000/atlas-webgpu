import * as d3 from 'd3';
import { width, height, gpuCanvas as webglCanvas } from './gpuContext.js';

import { getProjectionById } from '../config/projections.js';

let isAutoRotating = false;
let autoRotationRequestId = null;

export function toggleAutoRotation() {
    isAutoRotating = !isAutoRotating;
    if (isAutoRotating) animateAutoRotation();
    else stopAutoRotation();
}

export function stopAutoRotation() {
    isAutoRotating = false;
    if (autoRotationRequestId) {
        cancelAnimationFrame(autoRotationRequestId);
        autoRotationRequestId = null;
    }
}

function animateAutoRotation() {
    if (!isAutoRotating) return;
    orthoRotate[0] -= 0.5;
    requestRedraw();
    autoRotationRequestId = requestAnimationFrame(animateAutoRotation);
}

export let isOrthographic = new URLSearchParams(window.location.search).get('projection') === 'orthographic';
export const orthoRotate = [0.0, 0.0];
export const zoomState = { x: 0, y: 0, k: 1 };

export function setProjection(projId) {
    stopAutoRotation();
    isOrthographic = projId === 'orthographic';

    // Set initial zoom based on projection config
    const projConfig = getProjectionById(projId);
    zoomState.x = 0;
    zoomState.y = 0;
    zoomState.k = projConfig.initialZoom || 1.0;

    d3.select(webglCanvas).property("__zoom", d3.zoomIdentity.scale(zoomState.k));
    requestRebuild();
}

let onRedraw = null;
export function setRedrawCallback(cb) { onRedraw = cb; }
function requestRedraw() { if (onRedraw) onRedraw(); }

let onRebuildNeeded = null;
export function setRebuildCallback(cb) { onRebuildNeeded = cb; }
function requestRebuild() { if (onRebuildNeeded) onRebuildNeeded(); }

export const zoom = d3.zoom()
    .scaleExtent([1, 200000])
    .on('zoom', zoomed);

export const drag = d3.drag().on('drag', dragged);

export function initCamera() {
    d3.select(webglCanvas).call(zoom)
        .on("mousedown.zoom", null)
        .on("mouseup.zoom", null)
        .on("mousemove.zoom", null)
        .on("dblclick.zoom", null);
    d3.select(webglCanvas).call(drag);
}

function dragged(event) {
    stopAutoRotation();
    if (isOrthographic) {
        const latRad = orthoRotate[1] * Math.PI / 180;
        const sensBase = (180 / Math.PI) / 120; // 0.47746... pour un rayon de 120px
        const sens = sensBase / (zoomState.k * Math.max(0.1, Math.cos(latRad)));
        orthoRotate[0] -= event.dx * sens;
        orthoRotate[1] = Math.max(-90, Math.min(90, orthoRotate[1] + event.dy * (sensBase / zoomState.k)));
        requestRedraw();
    } else {
        zoomState.x += event.dx;
        zoomState.y += event.dy;
        d3.select(webglCanvas).property("__zoom", d3.zoomIdentity.translate(zoomState.x, zoomState.y).scale(zoomState.k));
        requestRedraw();
    }
}

function zoomed(event) {
    const newK = event.transform.k;
    if (event.sourceEvent && newK !== zoomState.k) {
        const rect = webglCanvas.getBoundingClientRect();
        const mousePoint = [event.sourceEvent.clientX - rect.left, event.sourceEvent.clientY - rect.top];
        interpolateZoomScale(zoomState.k, newK, mousePoint);
    } else {
        zoomState.x = event.transform.x;
        zoomState.y = event.transform.y;
        zoomState.k = event.transform.k;
        requestRedraw();
    }
}

let zoomAnimationId = null;
function interpolateZoomScale(fromK, toK, mousePoint, duration = 350) {
    if (zoomAnimationId) cancelAnimationFrame(zoomAnimationId);
    const startTime = performance.now();
    function animateZoom(currentTime) {
        const elapsed = currentTime - startTime;
        const t = Math.min(1, elapsed / duration);
        const easedT = 1 - Math.pow(1 - t, 3);
        const currentK = fromK + (toK - fromK) * easedT;
        const kRatio = currentK / zoomState.k;
        if (!isOrthographic) {
            const px = mousePoint[0] - width / 2;
            const py = mousePoint[1] - height / 2;
            zoomState.x = px - (px - zoomState.x) * kRatio;
            zoomState.y = py - (py - zoomState.y) * kRatio;
        } else {
            zoomState.x = 0; zoomState.y = 0;
        }
        zoomState.k = currentK;
        requestRedraw();
        if (t < 1) zoomAnimationId = requestAnimationFrame(animateZoom);
        else {
            zoomAnimationId = null;
            d3.select(webglCanvas).property("__zoom", d3.zoomIdentity.translate(zoomState.x, zoomState.y).scale(zoomState.k));
        }
    }
    zoomAnimationId = requestAnimationFrame(animateZoom);
}
