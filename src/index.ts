import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { startScheduler } from './scheduler';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startScheduler();
});
