const fs = require("node:fs");
const path = require("node:path");

const out = path.join(__dirname, "..", "dist");
fs.mkdirSync(out, { recursive: true });
console.log("built to", out);
