// Generates the Web Push key pair once. Paste both lines into .env.
const webpush = require("web-push");
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
