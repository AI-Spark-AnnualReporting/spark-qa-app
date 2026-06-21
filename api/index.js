// Vercel serverless entry point.
// Routes matched by vercel.json ("/api/(.*)") are handed to the Express app,
// which contains all the real route handlers (/api/qa, /api/review, /api/reports, ...).
import app from '../server.js';

export default app;
