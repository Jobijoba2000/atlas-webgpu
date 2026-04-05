# Atlas WebGPU

A high-performance WebGPU map rendering engine that compiles massive GeoJSON datasets into data-oriented binary buffers for blazing fast native-speed visualization.

## Features
- **WebGPU Native:** Leverages raw typed arrays to render massive topological features on the GPU.
- **Pre-compiled Binary Pipeline:** Eliminates parsing overhead by baking complex triangulations (earcut) and coordinates into optimized `.bin` files (`scripts/preprocess.js`).
- **Pixel-perfect Picking:** Supports 60FPS ID-based color picking offscreen texture for region selection.
- **Glassmorphism UI:** Modern, dynamic translucent control interfaces natively layered over the high-performance buffer.

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Jobijoba2000/atlas-webgpu.git
   cd atlas-webgpu
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Generate binary files**:
   ```bash
   node scripts/preprocess.js
   ```

## Usage

### Development Mode
Start the local server with hot reloading :
```bash
npm run dev
```

### Production Build
To generate an optimized bundle for hosting:
```bash
npm run build
```
Produced files will be inside `dist/`. You can preview the production build using:
```bash
npm run preview
```
