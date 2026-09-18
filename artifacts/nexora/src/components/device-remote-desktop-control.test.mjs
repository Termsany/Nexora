import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Match the existing callback-test approach, exercising the actual TSX locally.
const source = readFileSync(new URL('./device-remote-desktop-control.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('control.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node));
const js = ts.transpileModule(component.getText(ast).replace('export ', ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
function setup({ read = true, manage = true, pending = false, error = false, enabled = false } = {}) {
  let mutation, query, sent, refreshed = 0;
  const context = {
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    MonitorPlay: 'icon', Power: 'icon', Loader2: 'icon', RefreshCw: 'icon',
    useState: () => ['', () => {}],
    useCapability: (permission, org) => { assert.equal(org, 'org'); return permission === 'device:read' ? read : manage; },
    useQuery: config => { query = config; return { data: { device_id: 'device', remote_desktop_enabled: enabled, agent_supports_remote_desktop: true }, isError: error, refetch: async () => { refreshed++; } }; },
    useMutation: config => { mutation = config; return { isPending: pending, mutate: value => config.mutationFn(value) }; },
    apiRequest: async (path, init) => { sent = { path, init }; return {}; },
  };
  const render = vm.runInNewContext(`${js}\nDeviceRemoteDesktopControl`, context);
  const tree = render({ deviceId: 'device', organizationId: 'org' });
  const buttons = [];
  function visit(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); node.children?.flat(Infinity).forEach(visit); }
  visit(tree);
  return { tree, buttons, query, mutation, sent: () => sent, refreshed: () => refreshed };
}
test('reader without manage permission has no toggle', () => assert.equal(setup({ manage: false }).buttons.length, 0));
test('unreadable device hides the panel and disables its query', () => {
  const result = setup({ read: false }); assert.equal(result.tree, null); assert.equal(result.query.enabled, false);
});
test('enable submits only the device gate through apiRequest', async () => {
  const result = setup(); await result.buttons[0].props.onClick();
  assert.equal(result.sent().path, '/v1/devices/device/remote-desktop');
  assert.equal(result.sent().init.method, 'PATCH');
  assert.deepEqual(JSON.parse(result.sent().init.body), { enabled: true });
});
test('disable sends false, not a command or session request', async () => {
  const result = setup({ enabled: true }); await result.buttons[0].props.onClick();
  assert.deepEqual(JSON.parse(result.sent().init.body), { enabled: false });
});
test('pending save and failed status disable mutations', () => {
  assert.equal(setup({ pending: true }).buttons[0].props.disabled, true);
  assert.equal(setup({ error: true }).buttons[0].props.disabled, true);
});
test('successful mutation refreshes authoritative server state', async () => {
  const result = setup(); await result.mutation.onSuccess(); assert.equal(result.refreshed(), 1);
});
