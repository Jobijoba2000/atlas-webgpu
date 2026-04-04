// src/ui/Sidebar.js
import { appState } from '../state/appState.js';

export class Sidebar {
    constructor() {
        this.sidebarEl = document.getElementById('settings-sidebar');
        this.triggerBtn = document.getElementById('settings-trigger');
        this.closeBtn = document.querySelector('.close-sidebar');

        if (!this.sidebarEl) return;

        this.initEventListeners();
        this.initAccordions();
        this.bindStateToInputs();

        // Open first accordion by default
        const firstHeader = this.sidebarEl.querySelector('.accordion-header');
        if (firstHeader) firstHeader.click();
    }

    initEventListeners() {
        if (this.triggerBtn) {
            this.triggerBtn.addEventListener('click', () => this.toggle(true));
        }
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.toggle(false));
        }

        const inputs = this.sidebarEl.querySelectorAll('input, select');
        inputs.forEach(input => {
            input.addEventListener('input', (e) => this.handleInputChange(e.target));
            input.addEventListener('change', (e) => this.handleInputChange(e.target));
        });

        // Projection and Quality Buttons logic - Moved outside sidebar to bottom-left
        const projBtns = document.querySelectorAll('.svg-btn[data-proj]');
        projBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const proj = btn.dataset.proj;
                appState.set('projection', proj);
            });
        });

        // Sliding Overlay Toggle
        const overlayContainer = document.getElementById('map-overlays');
        const overlayToggle = document.getElementById('overlay-toggle');
        if (overlayToggle && overlayContainer) {
            overlayToggle.addEventListener('click', () => {
                overlayContainer.classList.toggle('is-open');
            });
        }
    }

    initAccordions() {
        const headers = this.sidebarEl.querySelectorAll('.accordion-header');
        headers.forEach(header => {
            header.addEventListener('click', () => {
                const content = header.nextElementSibling;
                const isActive = header.classList.contains('active');

                // Close all others
                headers.forEach(h => {
                    if (h !== header && h.classList.contains('active')) {
                        h.classList.remove('active');
                        h.nextElementSibling.style.maxHeight = null;
                    }
                });

                header.classList.toggle('active', !isActive);
                if (!isActive) {
                    content.style.maxHeight = "1000px"; // Use large value instead of scrollHeight to allow internal dynamic resizing
                } else {
                    content.style.maxHeight = null;
                }
            });
        });
    }

    updateDependentVisibility(key, isVisible) {
        const dependentGroup = this.sidebarEl.querySelector(`.dependent-group[data-depends="${key}"]`);
        if (dependentGroup) {
            if (isVisible) {
                dependentGroup.classList.remove('hidden-group');
            } else {
                dependentGroup.classList.add('hidden-group');
            }
        }
    }

    handleInputChange(input) {
        const key = input.dataset.key;
        if (!key) return;

        let value;
        if (input.type === 'checkbox') {
            value = input.checked;
            this.updateDependentVisibility(key, value);
        } else if (input.type === 'range' || input.type === 'number') {
            value = parseFloat(input.value);
            const displayEl = document.getElementById(`val-${key}`);
            if (displayEl) {
                displayEl.textContent = value.toFixed(input.step < 1 ? 1 : 0);
            }
        } else {
            value = input.value;
            if (value === 'true') value = true;
            if (value === 'false') value = false;
        }

        appState.set(key, value);
    }

    bindStateToInputs() {
        const projBtns = document.querySelectorAll('.svg-btn[data-proj]');
        const inputs = this.sidebarEl.querySelectorAll('input, select');
        inputs.forEach(input => {
            const key = input.dataset.key;
            if (!key) return;

            const val = appState.get(key);
            if (val !== undefined) {
                if (input.type === 'checkbox') {
                    input.checked = val;
                    this.updateDependentVisibility(key, val);
                } else if (input.type === 'range' || input.type === 'number') {
                    input.value = val;
                    const displayEl = document.getElementById(`val-${key}`);
                    if (displayEl) {
                        displayEl.textContent = Number(val).toFixed(input.step < 1 ? 1 : 0);
                    }
                } else {
                    input.value = val.toString();
                }
            }
        });

        const projVal = appState.get('projection');
        if (projVal) {
            projBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.proj === projVal));
        }

        appState.subscribe((state, key, value) => {
            if (key === 'projection') {
                projBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.proj === value));
            }
            const input = this.sidebarEl.querySelector(`[data-key="${key}"]`);
            if (input && document.activeElement !== input) {
                if (input.type === 'checkbox') {
                    input.checked = value;
                    this.updateDependentVisibility(key, value);
                } else if (input.type === 'range' || input.type === 'number') {
                    input.value = value;
                    const displayEl = document.getElementById(`val-${key}`);
                    if (displayEl) displayEl.textContent = Number(value).toFixed(input.step < 1 ? 1 : 0);
                } else {
                    input.value = value.toString();
                }
            }
        });
    }

    toggle(show) {
        if (show) {
            this.sidebarEl.classList.add('active');
        } else {
            this.sidebarEl.classList.remove('active');
        }
    }
}
