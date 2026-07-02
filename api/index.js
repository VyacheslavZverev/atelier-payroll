// Vercel serverless entry point: every /api/* request is rewritten here (see
// vercel.json) and handled by the same Express app the PC server runs.
import app from '../server/index.js';

export default app;
