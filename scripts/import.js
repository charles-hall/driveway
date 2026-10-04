// One-time import of the data exported from the Claude version.
// Put vehicles.json, parts.json and history.json in ./import, then run:
//   npm run import -- "Household name"   (or its number; optional when there's only one)
// Each file is an array of documents with an "id" field. Existing IDs are kept,
// so parts stay linked to maintenance items and history stays linked to vehicles.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const store = require("../lib/db");

const dir = path.join(__dirname, "..", "import");
const which = process.argv[2];
const all = store.listHouseholds();
const h = which ? all.find(x => String(x.id) === which || x.name.toLowerCase() === which.toLowerCase()) : all.length === 1 ? all[0] : null;
if (!h) {
  console.log(all.length ? `Name the household to import into: ${all.map(x => `${x.id} "${x.name}"`).join(", ")}` : "No households yet. Create one in the app first.");
  process.exit(1);
}
let total = 0;
for (const col of ["vehicles", "parts", "history"]) {
  const file = path.join(dir, `${col}.json`);
  if (!fs.existsSync(file)) { console.log(`skip ${col}: no ${file}`); continue; }
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const tx = store.db.transaction(list => {
    for (const r of list) { const { id, ...body } = r; store.putDoc(h.id, col, id, body, null); }
  });
  tx(rows);
  console.log(`${col}: ${rows.length} imported`);
  total += rows.length;
}
console.log(`Done. ${total} documents imported into ${h.name}.`);
