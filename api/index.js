'use strict';
// Vercel entry point. All /api/* and /agent/* requests are rewritten here (see vercel.json).
const { handler } = require('../server');

module.exports = handler;
