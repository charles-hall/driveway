// Add a person to a household from the command line, or change their role there.
//   npm run add-user -- someone@gmail.com editor            (when there's only one household)
//   npm run add-user -- someone@gmail.com editor "Cottage"  (household name or number)
// To create a household, use Settings > Households in the app (site admin only).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const store = require("../lib/db");
const [email, role = "viewer", which] = process.argv.slice(2);
if (!email || !store.ROLES.includes(role)) {
  console.log('Usage: npm run add-user -- <google email> <owner|editor|viewer> ["Household name" or number]');
  process.exit(1);
}
const all = store.listHouseholds();
const h = which ? all.find(x => String(x.id) === which || x.name.toLowerCase() === which.toLowerCase()) : all.length === 1 ? all[0] : null;
if (!h) {
  console.log(all.length ? `Name the household: ${all.map(x => `${x.id} "${x.name}"`).join(", ")}` : "No households yet. Create one in the app first.");
  process.exit(1);
}
const u = store.ensureUser(email, null);
if (store.membership(h.id, u.id)) { store.setMemberRole(h.id, u.id, role); console.log(`${email} is now ${role} in ${h.name}.`); }
else { store.addMember(h.id, u.id, role, null); console.log(`${email} added to ${h.name} as ${role}. They can sign in with Google now.`); }
