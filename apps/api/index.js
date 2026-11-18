// Vercel entry for the API service (see vercel.json → services.api.entrypoint).
// It must exist in the repo before the build, so it is plain JavaScript and simply
// loads the compiled app from dist/ (built from src/vercel.ts by the buildCommand).
import 'express';
export { default } from './dist/vercel.js';
