import assert from "node:assert/strict";
import test from "node:test";
import { commandSchema } from "./remote-command-validation.ts";

const request = command => ({ device_id: "17f19436-b5a7-4693-82e2-c73ba1615da4", shell: "POWERSHELL", command, reason: "Local test", timeout_seconds: 180 });
const cases = {
  "one line": "hostname",
  multiline: "# diagnostic\n$Value = 'abc'\nWrite-Output $Value",
  "leading whitespace": " \t\nhostname",
  "trailing whitespace": "hostname \t",
  "final newline": "hostname\n",
  LF: "# comment\nWrite-Output 'x'\n",
  CRLF: "# comment\r\nWrite-Output 'x'\r\n",
  "blank lines": "# comment\n\nWrite-Output 'x'\n\n",
  tabs: "\tWrite-Output 'x'\t",
  indentation: "    Write-Output 'x'",
  quotes: "Write-Output \"'quoted'\"",
  backticks: 'Write-Output "a`nb"',
  braces: "& { Write-Output 'x' }",
  semicolons: "$x=1; Write-Output $x;",
  Unicode: 'Write-Output "\u0645\u0631\u062d\u0628\u0627 \ud83d\ude00"',
};
for (const [name, command] of Object.entries(cases)) {
  test(`command preserves exactly: ${name}`, () => {
    assert.equal(commandSchema.parse(JSON.parse(JSON.stringify(request(command)))).command, command);
  });
}
for (const [name, command] of Object.entries({ empty: "", spaces: "   ", "tabs and newlines": "\t\r\n\n", "Unicode whitespace": "\u00a0\u2003" })) {
  test(`command rejects ${name}`, () => assert.equal(commandSchema.safeParse(request(command)).success, false));
}
test("command accepts exactly 65536 UTF-16 code units unchanged", () => {
  const command = " " + "x".repeat(65533) + "\r\n";
  assert.equal(command.length, 65536);
  assert.equal(commandSchema.parse(request(command)).command, command);
});
test("command rejects 65537 original code units, including excess whitespace", () => {
  for (const command of ["x".repeat(65537), " " + "x".repeat(65536), "x".repeat(65536) + "\n"]) {
    assert.equal(commandSchema.safeParse(request(command)).success, false);
  }
});
test("command limit measures UTF-16, not UTF-8 bytes", () => {
  const command = "\ud83d\ude00".repeat(32768);
  assert.equal(command.length, 65536);
  assert.equal(commandSchema.parse(request(command)).command, command);
  assert.equal(commandSchema.safeParse(request(command + "x")).success, false);
});
test("shell allowlist and timeout bounds remain enforced", () => {
  for (const shell of ["CMD", "POWERSHELL"]) assert.equal(commandSchema.safeParse({ ...request("hostname"), shell }).success, true);
  assert.equal(commandSchema.safeParse({ ...request("hostname"), shell: "BASH" }).success, false);
  for (const timeout_seconds of [0, 901]) assert.equal(commandSchema.safeParse({ ...request("hostname"), timeout_seconds }).success, false);
});
