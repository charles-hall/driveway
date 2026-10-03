// Add or update a person from the command line (useful before the first sign-in).
//   npm run add-user -- someone@gmail.com editor
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const store = require("../lib/db");
const [email, role = "viewer"] = process.argv.slice(2);
if (!email || !["owner", "editor", "viewer"].includes(role)) {
  console.log("Usage: npm run add-user -- <google email> <owner|editor|viewer>");
  process.exit(1);
}
const u = store.userByEmail(email);
if (u) { store.setRole(u.id, role); console.log(`${email} is now ${role}.`); }
else { store.addUser(email, role, null); console.log(`${email} added as ${role}. They can sign in with Google now.`); }
