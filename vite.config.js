import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

export default defineConfig({
    server: {
        port: 3000,
        host: '0.0.0.0'
    },
    plugins: [
        {
            name: 'list-custom-bins',
            configureServer(server) {
                server.middlewares.use('/api/custom-maps', (req, res, next) => {
                    const dir = path.resolve(__dirname, 'public/data/custom_bin');
                    if (!fs.existsSync(dir)) {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify([]));
                        return;
                    }
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.bin'));
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(files));
                });
            }
        }
    ],
    build: {
        minify: false
    }
})