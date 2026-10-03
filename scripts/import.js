// One-time import of the data exported from the Claude version.
// Put vehicles.json, parts.json and history.json in ./import, then run:  npm run import
// Each file is an array of documents with an "id" field. Existing IDs are kept,
// so parts stay linked to maintenance items and history stays linked to vehicles.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const store = require("../lib/db");

const dir = path.join(__dirname, "..", "import");
let total = 0;
for (const col of ["vehicles", "parts", "history"]) {
  const file = path.join(dir, `${col}.json`);
  if (!fs.existsSync(file)) { console.log(`skip ${col}: no ${file}`); continue; }
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const tx = store.db.transaction(list => {
    for (const r of list) { const { id, ...body } = r; store.putDoc(col, id, body, null); }
  });
  tx(rows);
  console.log(`${col}: ${rows.length} imported`);
  total += rows.length;
}
console.log(`Done. ${total} documents in ${process.env.DB_PATH || "the default database"}.`);
