// Mount the phone's compiled React components in Node. Native views are supplied by each test.
import { transformFileSync } from "@babel/core";
import Module, { createRequire } from "node:module";
import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const load = createRequire(__filename);

export function phoneModule(path: string, imports: Record<string, unknown>) {
  const file = load.resolve(path);
  const { code } = transformFileSync(file, {
    babelrc: false, configFile: false, presets: [load.resolve("babel-preset-expo")],
    caller: { name: "metro", platform: "ios", engine: "hermes", supportsReactCompiler: true, isDev: false },
  })!;
  const fromFile = createRequire(file);
  const mod = new Module(file);
  mod.filename = file;
  mod.require = (name) => Object.hasOwn(imports, name) ? imports[name] : fromFile(name);
  mod._compile(code, file);
  return mod.exports;
}

export async function mount(element: ReactElement) {
  let root: ReactTestRenderer;
  await act(async () => { root = create(element); });
  return { root: root!, unmount: () => act(async () => root!.unmount()) };
}
