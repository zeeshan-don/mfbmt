/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const pdfParse = require("pdf-parse");
const file = process.argv[2];
const buffer = fs.readFileSync(file);
pdfParse(buffer)
  .then((data) => {
    process.stdout.write(JSON.stringify({ pages: data.numpages, text: data.text }));
  })
  .catch((error) => {
    process.stderr.write(error && error.message ? error.message : String(error));
    process.exit(1);
  });