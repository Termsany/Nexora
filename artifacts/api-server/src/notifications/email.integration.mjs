import assert from "node:assert/strict";
import { sendEmail } from "./adapters/email.ts";

const payload = { event: "TEST", timestamp: new Date().toISOString(), test: { server: "disposable-smtp" } };
await sendEmail(payload);
await new Promise((resolve) => setTimeout(resolve, 250));
const response = await fetch("http://nexora-smtp-test:8025/api/v1/messages");
assert.equal(response.ok, true);
const messages = await response.json();
assert.equal(messages.total, 1);
assert.match(messages.messages[0].Subject, /Nexora.*Test/);
console.log(JSON.stringify({ smtp_delivery: "PASS", messages: messages.total }));
