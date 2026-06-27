import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/** Length-independent constant-time string compare (avoids leaking the key via timing). */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    // Hash both to a fixed length so timingSafeEqual never sees mismatched sizes
    // (which would itself throw/short-circuit and leak length).
    const ah = crypto.createHash('sha256').update(ab).digest();
    const bh = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(ah, bh);
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'];
    const validKey = process.env.API_KEY;

    if (!validKey) {
        console.error('API_KEY is not defined in environment variables');
        res.status(500).json({ error: 'Internal Server Error: Security configuration missing' });
        return;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' });
        return;
    }

    const token = authHeader.slice(7);
    if (!safeEqual(token, validKey)) {
        res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        return;
    }

    next();
};
