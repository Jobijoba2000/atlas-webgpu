// src/state/appState.js
import { defaultConfig } from '../config/defaultConfig.js';

class AppState {
    constructor() {
        this.config = { ...defaultConfig };
        this.listeners = [];
    }

    /**
     * Parse initial config from URL parameters
     */
    initFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);

        // Map short URL params to config keys
        const paramMap = {
            'res': 'resolution',
            'proj': 'projection'
        };

        for (const [param, key] of Object.entries(paramMap)) {
            if (urlParams.has(param)) {
                this.config[key] = urlParams.get(param);
            }
        }

        // Also check for direct config keys
        for (const [key, value] of Object.entries(this.config)) {
            if (urlParams.has(key)) {
                const paramValue = urlParams.get(key);

                if (typeof value === 'boolean') {
                    this.config[key] = paramValue === 'true' || paramValue === '1';
                } else if (typeof value === 'number') {
                    this.config[key] = parseFloat(paramValue);
                } else {
                    this.config[key] = paramValue;
                }
            }
        }
    }

    syncToUrl() {
        const urlParams = new URLSearchParams(window.location.search);

        // Only sync a subset of "peristable" keys to keep URL clean
        const persistable = {
            'projection': 'proj',
            'resolution': 'res'
        };

        for (const [key, param] of Object.entries(persistable)) {
            const val = this.config[key];
            if (val !== undefined) {
                urlParams.set(param, val);
            }
        }

        const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
        window.history.replaceState({}, '', newUrl);
    }

    get(key) {
        return this.config[key];
    }

    set(key, value) {
        if (this.config[key] !== value) {
            this.config[key] = value;

            // Sync to URL if it's a persistable property
            const persistable = ['projection', 'resolution'];
            if (persistable.includes(key)) {
                this.syncToUrl();
            }

            this.notify(key, value);
        }
    }

    updateMultiple(newSettings) {
        let changed = false;
        let pChanged = false;
        const persistable = ['projection', 'resolution'];

        for (const [key, value] of Object.entries(newSettings)) {
            if (this.config[key] !== value) {
                this.config[key] = value;
                changed = true;
                if (persistable.includes(key)) pChanged = true;
            }
        }
        if (changed) {
            if (pChanged) this.syncToUrl();
            this.notify('multiple', newSettings);
        }
    }

    subscribe(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    notify(key, value) {
        for (const listener of this.listeners) {
            listener(this.config, key, value);
        }
    }

    getTheme() {
        return {
            countrySat: this.config.countrySaturation,
            countryLit: this.config.countryLightness
        };
    }
}

export const appState = new AppState();
