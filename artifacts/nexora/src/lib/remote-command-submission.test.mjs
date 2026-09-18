import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { commandSchema } from "../../../api-server/src/security/remote-command-validation.ts";

// Exercise the actual form's change/submit callbacks without a browser or HTTP.
const source = readFileSync(new URL("../pages/device-detail.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("device-detail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let panel, submit, editor;
function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
visit(ast, node => { if (ts.isFunctionDeclaration(node) && node.name?.text === "RemoteCommandsPanel") panel = node; });
assert.ok(panel);
visit(panel, node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "submit") submit = node.initializer;
  if (ts.isJsxSelfClosingElement(node) && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === "value" && p.initializer?.expression?.getText(ast) === "command")) editor = node;
});
assert.ok(submit); assert.ok(editor);
const onChange = editor.attributes.properties.find(p => p.name?.getText(ast) === "onChange").initializer.expression;
function callback(node, context) {
  const js = ts.transpileModule(`const fn = ${node.getText(ast)}; fn;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(js, context);
}
test("Command control is a multiline textarea without a smaller maxlength", () => {
  assert.equal(editor.tagName.getText(ast), "textarea");
  assert.equal(editor.attributes.properties.some(p => p.name?.getText(ast) === "maxLength"), false);
});
async function roundTrip(original) {
  let state, captured, prevented = false;
  callback(onChange, { setCommand: value => { state = value; } })({ target: { value: original } });
  assert.equal(state, original);
  const context = {
    device: { id: "17f19436-b5a7-4693-82e2-c73ba1615da4" }, shell: "POWERSHELL", command: state, timeout: "180", reason: "Local test",
    setNotice() {}, setDialogOpen() {},
    async apiRequest(path, options) {
      assert.equal(path, "/v1/remote-commands"); assert.equal(options.method, "POST");
      captured = JSON.parse(options.body);
      return { job: { id: "test-job" }, privileged_action_id: "test-action" };
    },
  };
  await callback(submit, context)({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.ok(captured);
  assert.equal(captured.command, original);
  const validated = commandSchema.parse(captured);
  assert.equal(validated.command, original);
  assert.equal(validated.command.length, original.length);
}
const script = ' \t# diagnostic\n$Value = "abc"\n\n    & { Write-Output "\u0645\u0631\u062d\u0628\u0627 $Value`n"; }\n\t';
test("actual form change/submit/JSON/schema preserves LF text exactly", () => roundTrip(script));
test("application callbacks preserve CRLF text supplied to them exactly", () => roundTrip(script.replaceAll("\n", "\r\n")));
test("real diagnostic remains exact through form submission and backend validation", { skip: !process.env.NEXORA_DIAGNOSTIC_FIXTURE }, async () => {
  const bytes = readFileSync(process.env.NEXORA_DIAGNOSTIC_FIXTURE);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "698cb309b948bcad6cae27d191c933c601aee489da7e215bf24370254af55a06");
  const text = bytes.toString("utf8");
  assert.equal(text.length, 10886);
  await roundTrip(text);
});
