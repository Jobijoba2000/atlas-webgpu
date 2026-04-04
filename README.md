# WebGL World Map

Une carte du monde interactive en WebGL avec morphing entre projections (Mercator, Mollweide, Natural Earth 2, Orthographique).

## Installation

1. **Cloner le projet** :
   ```bash
   git clone https://github.com/Jobijoba2000/world-map-webgl.git
   cd world-map-webgl
   ```

2. **Installer les dépendances** :
   ```bash
   npm install
   ```

3. **Générer les fichiers binaires** :
   ```bash
   node scripts/preprocess.js
   ```

## Utilisation

### Mode Développement
Lancez le serveur local avec rechargement automatique :
```bash
npm run dev
```

### Mode Production (Build)
Pour générer une version optimisée du site :
```bash
npm run build
```
Les fichiers générés se trouveront dans le dossier `dist/`. Pour les tester localement :
```bash
npm run preview
```
