import express from 'express';
import cors from 'cors';
import router from './routes';

const app = express();

app.use(cors());
// Bounded body size: generous enough for CSV DNC imports, capped to blunt
// memory-exhaustion via oversized payloads.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));

app.use(router);

// Health check
app.get('/health', (req, res) => {
    res.send('OK');
});

export default app;
