// Vercel entry for the API service (see vercel.json → services.api.entrypoint).
// CommonJS on purpose: Vercel loads its entry file as CommonJS, so an ES-module entry crashes
// with "Cannot use import statement outside a module". The real app (src/vercel.ts) is bundled
// into vercel/index.js by the build command ("npm run build:vercel -w apps/api").
require('express'); // lets Vercel recognise this as the Express entry
module.exports = require('./vercel/index.js');
