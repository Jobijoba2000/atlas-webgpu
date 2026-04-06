import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const app = express();
app.use(cors());
app.use(express.json());

const tts = new MsEdgeTTS();

// Nouveau endpoint pour lister les cartes sans manifest
app.get('/api/custom-maps', (req, res) => {
    const dir = path.join(process.cwd(), 'public/data/custom_bin');
    if (!fs.existsSync(dir)) return res.json([]);
    
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.bin'));
    res.json(files);
});

app.get('/api/tts', async (req, res) => {
    try {
        const text = req.query.text;
        const rate = req.query.rate || "+10%"; // Vitesse accélérée
        const voice = req.query.voice || "fr-FR-DeniseNeural"; // Voix premium

        if (!text) {
            return res.status(400).send("Text parameter is required");
        }

        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        // Option de pitch et rate dans msedge-tts
        const audioStream = tts.toStream(text, { rate: rate });

        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked'
        });

        audioStream.pipe(res);

    } catch (error) {
        console.error("TTS Error:", error);
        res.status(500).send("TTS Generation Failed");
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`TTS API Server running on http://localhost:${PORT}`);
});
