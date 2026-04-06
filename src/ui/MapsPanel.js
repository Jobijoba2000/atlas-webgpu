import { appState } from '../state/appState.js';

export class MapsPanel {
    constructor(loaders) {
        this.loaders = loaders;
        this.triggerBtn = document.getElementById('maps-trigger');
        this.panelEl = document.getElementById('maps-panel');
        this.closeBtn = document.getElementById('close-maps');
        this.listEl = document.getElementById('maps-list');
        this.isOpen = false;

        if (!this.panelEl) return;

        this.init();
    }

    async    init() {
        this.triggerBtn.addEventListener('click', () => this.toggle());
        this.closeBtn.addEventListener('click', () => this.toggle());

        // Bouton Reset en bas
        const resetMapBtn = document.getElementById('reset-map');
        if (resetMapBtn) {
            resetMapBtn.onclick = () => {
                appState.set('customMap', null);
                document.body.classList.remove('custom-map-active');
                this.loaders.loadGlobalData();
                this.toggle(false);
            };
        }

        // Initial manifest load
        this.refresh();
    }

    async refresh() {
        try {
            // On utilise l'API intégrée au serveur Vite (Port 3000)
            const resp = await fetch('/api/custom-maps');
            if (!resp.ok) throw new Error('API not available');
            const files = await resp.json();
            this.renderList(files);
        } catch (err) {
            console.error('Erreur listing maps:', err);
            this.listEl.innerHTML = '<div style="font-size: 11px; opacity: 0.4; text-align: center; padding: 20px;">Impossible de lister les fichiers personnalisés.</div>';
        }
    }

    renderList(files) {
        this.listEl.innerHTML = '';
        
        if (!files || files.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'font-size: 11px; opacity: 0.4; text-align: center; padding: 20px;';
            empty.innerText = 'Aucun fichier .bin trouvé dans custom_bin.';
            this.listEl.appendChild(empty);
            return;
        }

        files.forEach(fileName => {
            const btn = document.createElement('div');
            btn.style.cssText = `
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                padding: 12px 15px;
                cursor: pointer;
                transition: all 0.2s ease;
                margin-bottom: 8px;
            `;
            btn.innerHTML = `
                <div style="font-weight: 700; font-size: 13px; color: #fff;">${fileName}</div>
            `;

            btn.onclick = () => {
                appState.set('customMap', fileName);
                document.body.classList.add('custom-map-active');
                this.loaders.loadCustomMapData(`data/custom_bin/${fileName}`);
                this.toggle(false);
            };
            this.listEl.appendChild(btn);
        });
    }

    toggle(force) {
        this.isOpen = force !== undefined ? force : !this.isOpen;
        if (this.isOpen) {
            this.panelEl.style.opacity = '1';
            this.panelEl.style.pointerEvents = 'all';
            this.panelEl.style.transform = 'translateY(0)';
            this.refresh(); // Refresh list every time we open
        } else {
            this.panelEl.style.opacity = '0';
            this.panelEl.style.pointerEvents = 'none';
            this.panelEl.style.transform = 'translateY(-10px)';
        }
    }
}
