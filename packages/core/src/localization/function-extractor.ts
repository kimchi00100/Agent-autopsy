import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';

export interface ExtractedFunction {
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  calls: string[];
}

export interface FunctionExtractionResult {
  supported: boolean;
  language?: string;
  functions: ExtractedFunction[];
}

interface LanguageSpec {
  langId: string;
  wasmFile: string;
}

const EXTENSION_MAP: Record<string, LanguageSpec> = {
  '.py': { langId: 'python', wasmFile: 'tree-sitter-python.wasm' },
  '.js': { langId: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.mjs': { langId: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.cjs': { langId: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.jsx': { langId: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' },
  '.ts': { langId: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.tsx': { langId: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' },
  '.c': { langId: 'c', wasmFile: 'tree-sitter-c.wasm' },
  '.cc': { langId: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' },
  '.cpp': { langId: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' },
  '.cxx': { langId: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' },
  '.h': { langId: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' },
  '.hpp': { langId: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' },
};

function getWasmSearchDirs(): string[] {
  const dirs: string[] = [];

  if (typeof __dirname !== 'undefined') {
    dirs.push(path.resolve(__dirname, 'wasm'));
    dirs.push(path.resolve(__dirname, '../wasm'));
    dirs.push(path.resolve(__dirname, '../../wasm'));
    dirs.push(__dirname);
  }

  const proc = process as unknown as { resourcesPath?: string };
  if (proc.resourcesPath) {
    dirs.push(path.resolve(proc.resourcesPath, 'bundled', 'wasm'));
    dirs.push(path.resolve(proc.resourcesPath, 'bundled'));
    dirs.push(path.resolve(proc.resourcesPath, 'wasm'));
  }

  const cwd = process.cwd();
  dirs.push(path.resolve(cwd, 'apps/desktop/electron/bundled/wasm'));
  dirs.push(path.resolve(cwd, 'packages/core/node_modules/tree-sitter-wasms/out'));
  dirs.push(path.resolve(cwd, 'node_modules/tree-sitter-wasms/out'));

  return dirs;
}

function getRequire(): NodeRequire | null {
  try {
    if (typeof require !== 'undefined') {
      return require;
    }
  } catch {}
  try {
    let base = process.cwd();
    if (typeof __filename !== 'undefined') {
      base = __filename;
    } else if (typeof import.meta !== 'undefined' && (import.meta as any).url) {
      base = fileURLToPath((import.meta as any).url);
    }
    return createRequire(base);
  } catch {
    return null;
  }
}

function resolveTreeSitterWasmPath(): string {
  for (const dir of getWasmSearchDirs()) {
    const candidate = path.join(dir, 'tree-sitter.wasm');
    if (fs.existsSync(candidate)) return candidate;
  }

  const req = getRequire();
  if (req) {
    try {
      const wtsPkg = req.resolve('web-tree-sitter');
      const candidate = path.join(path.dirname(wtsPkg), 'tree-sitter.wasm');
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const cwd = process.cwd();
  const fallbacks = [
    path.resolve(cwd, 'packages/core/node_modules/web-tree-sitter/tree-sitter.wasm'),
    path.resolve(cwd, 'node_modules/web-tree-sitter/tree-sitter.wasm'),
    path.resolve(cwd, 'apps/desktop/electron/bundled/wasm/tree-sitter.wasm'),
  ];
  for (const fb of fallbacks) {
    if (fs.existsSync(fb)) return fb;
  }

  throw new Error('tree-sitter.wasm not found in search paths');
}

function resolveLanguageWasmPath(wasmName: string): string {
  for (const dir of getWasmSearchDirs()) {
    const candidate = path.join(dir, wasmName);
    if (fs.existsSync(candidate)) return candidate;
  }

  const req = getRequire();
  if (req) {
    try {
      const tswPkg = req.resolve('tree-sitter-wasms/package.json');
      const candidate = path.join(path.dirname(tswPkg), 'out', wasmName);
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const cwd = process.cwd();
  const fallbacks = [
    path.resolve(cwd, 'packages/core/node_modules/tree-sitter-wasms/out', wasmName),
    path.resolve(cwd, 'node_modules/tree-sitter-wasms/out', wasmName),
    path.resolve(cwd, 'apps/desktop/electron/bundled/wasm', wasmName),
  ];
  for (const fb of fallbacks) {
    if (fs.existsSync(fb)) return fb;
  }

  throw new Error(`Tree-sitter language WASM not found: ${wasmName}`);
}

let initPromise: Promise<void> | null = null;
const loadedLanguages = new Map<string, Parser.Language>();

export async function initTreeSitter(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const wtsPath = resolveTreeSitterWasmPath();
    await Parser.init({
      locateFile: () => wtsPath,
    });
  })();

  return initPromise;
}

async function getLanguage(spec: LanguageSpec): Promise<Parser.Language> {
  await initTreeSitter();
  const existing = loadedLanguages.get(spec.langId);
  if (existing) return existing;

  const wasmPath = resolveLanguageWasmPath(spec.wasmFile);
  const lang = await Parser.Language.load(wasmPath);
  loadedLanguages.set(spec.langId, lang);
  return lang;
}

function extractCalls(node: Parser.SyntaxNode): string[] {
  const calls = new Set<string>();

  function visit(n: Parser.SyntaxNode) {
    // Do not descend into nested function or method definitions
    if (
      n !== node &&
      (n.type === 'function_definition' ||
        n.type === 'function_declaration' ||
        n.type === 'method_definition' ||
        n.type === 'arrow_function' ||
        n.type === 'function_expression')
    ) {
      return;
    }

    if (n.type === 'call' || n.type === 'call_expression') {
      const fnChild = n.childForFieldName('function');
      if (fnChild) {
        if (fnChild.type === 'identifier') {
          calls.add(fnChild.text);
        } else if (fnChild.type === 'attribute') {
          const attr = fnChild.childForFieldName('attribute');
          if (attr) calls.add(attr.text);
        } else if (fnChild.type === 'member_expression' || fnChild.type === 'field_expression') {
          const prop = fnChild.childForFieldName('property') || fnChild.childForFieldName('field');
          if (prop) calls.add(prop.text);
        } else if (fnChild.type === 'qualified_identifier') {
          const nameChild = fnChild.childForFieldName('name');
          if (nameChild) calls.add(nameChild.text);
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) visit(child);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) visit(child);
  }

  return Array.from(calls);
}

function unwrapCppDeclarator(node: Parser.SyntaxNode | null): { name: string } | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return { name: node.text };
  }
  if (node.type === 'qualified_identifier') {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    if (scope && name) {
      return { name: `${scope.text}.${name.text}` };
    }
    return { name: node.text.replace(/::/g, '.') };
  }
  if (
    node.type === 'function_declarator' ||
    node.type === 'pointer_declarator' ||
    node.type === 'reference_declarator'
  ) {
    const inner = node.childForFieldName('declarator');
    if (inner) {
      const res = unwrapCppDeclarator(inner);
      if (res) return res;
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const res = unwrapCppDeclarator(child);
      if (res) return res;
    }
  }
  return null;
}

export async function parseWithTreeSitterForRunner(
  runnerType: string,
  content: string
): Promise<Parser.Tree | null> {
  try {
    let spec: LanguageSpec | null = null;
    if (runnerType === 'pytest' || runnerType === 'unittest') {
      spec = EXTENSION_MAP['.py'];
    } else if (runnerType === 'node:test') {
      spec = EXTENSION_MAP['.js'];
    }
    if (!spec) return null;
    const lang = await getLanguage(spec);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser.parse(content);
  } catch {
    return null;
  }
}

export async function extractFunctions(filePath: string, content: string): Promise<FunctionExtractionResult> {
  const ext = path.extname(filePath).toLowerCase();
  const spec = EXTENSION_MAP[ext];
  if (!spec) {
    return { supported: false, functions: [] };
  }

  let lang: Parser.Language;
  try {
    lang = await getLanguage(spec);
  } catch {
    return { supported: false, functions: [] };
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  const lines = content.split(/\r?\n/);
  const functions: ExtractedFunction[] = [];

  function getSignature(startLine: number): string {
    const line = lines[startLine - 1] || '';
    return line.trim();
  }

  // 1. Python AST Walker
  function walkPython(node: Parser.SyntaxNode, currentClass: string | null) {
    if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode ? nameNode.text : 'AnonymousClass';
      const body = node.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkPython(child, className);
        }
      }
      return;
    }

    if (node.type === 'decorated_definition') {
      const defNode = node.childForFieldName('definition');
      if (defNode && defNode.type === 'function_definition') {
        const nameNode = defNode.childForFieldName('name');
        const baseName = nameNode ? nameNode.text : 'anonymous';
        const funcName = currentClass ? `${currentClass}.${baseName}` : baseName;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const defStartLine = defNode.startPosition.row + 1;
        const signature = getSignature(defStartLine);
        const body = defNode.childForFieldName('body');
        const calls = body ? extractCalls(body) : [];
        functions.push({ name: funcName, startLine, endLine, signature, calls });
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) walkPython(child, null);
          }
        }
        return;
      }
    }

    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const baseName = nameNode ? nameNode.text : 'anonymous';
      const funcName = currentClass ? `${currentClass}.${baseName}` : baseName;
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const signature = getSignature(startLine);
      const body = node.childForFieldName('body');
      const calls = body ? extractCalls(body) : [];
      functions.push({ name: funcName, startLine, endLine, signature, calls });
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkPython(child, null);
        }
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkPython(child, currentClass);
    }
  }

  // 2. JS / TS Walker
  function walkJsTs(node: Parser.SyntaxNode, currentClass: string | null) {
    if (node.type === 'class_declaration' || node.type === 'class') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode ? nameNode.text : 'AnonymousClass';
      const body = node.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkJsTs(child, className);
        }
      }
      return;
    }

    if (node.type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      const baseName = nameNode ? nameNode.text : 'anonymous';
      const funcName = currentClass ? `${currentClass}.${baseName}` : baseName;
      let startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;

      // Include preceding decorators if any
      const parent = node.parent;
      if (parent) {
        for (let i = 0; i < parent.childCount; i++) {
          const sibling = parent.child(i);
          if (sibling?.id === node.id) {
            // Check preceding siblings for decorators
            let prevIdx = i - 1;
            while (prevIdx >= 0 && parent.child(prevIdx)?.type === 'decorator') {
              const dec = parent.child(prevIdx);
              if (dec) startLine = Math.min(startLine, dec.startPosition.row + 1);
              prevIdx--;
            }
            break;
          }
        }
      }

      const signature = getSignature(node.startPosition.row + 1);
      const body = node.childForFieldName('body');
      const calls = body ? extractCalls(body) : [];
      functions.push({ name: funcName, startLine, endLine, signature, calls });
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkJsTs(child, null);
        }
      }
      return;
    }

    if (
      node.type === 'public_field_definition' ||
      node.type === 'field_definition' ||
      node.type === 'property_definition'
    ) {
      const valueNode = node.childForFieldName('value');
      if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
        const nameNode = node.childForFieldName('property') || node.childForFieldName('name');
        const baseName = nameNode ? nameNode.text : 'anonymous';
        const funcName = currentClass ? `${currentClass}.${baseName}` : baseName;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const signature = getSignature(startLine);
        const body = valueNode.childForFieldName('body');
        const calls = body ? extractCalls(body) : [];
        functions.push({ name: funcName, startLine, endLine, signature, calls });
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) walkJsTs(child, null);
          }
        }
        return;
      }
    }

    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      const baseName = nameNode ? nameNode.text : 'anonymous';
      const funcName = currentClass ? `${currentClass}.${baseName}` : baseName;
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const signature = getSignature(startLine);
      const body = node.childForFieldName('body');
      const calls = body ? extractCalls(body) : [];
      functions.push({ name: funcName, startLine, endLine, signature, calls });
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkJsTs(child, null);
        }
      }
      return;
    }

    if (node.type === 'variable_declarator') {
      const init = node.childForFieldName('value');
      if (init && (init.type === 'arrow_function' || init.type === 'function_expression')) {
        const nameNode = node.childForFieldName('name');
        const funcName = nameNode ? nameNode.text : 'anonymous';
        const startLine = node.parent ? node.parent.startPosition.row + 1 : node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const signature = getSignature(startLine);
        const body = init.childForFieldName('body');
        const calls = body ? extractCalls(body) : [];
        functions.push({ name: funcName, startLine, endLine, signature, calls });
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) walkJsTs(child, null);
          }
        }
        return;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkJsTs(child, currentClass);
    }
  }

  // 3. C / C++ Walker
  function walkCpp(node: Parser.SyntaxNode, currentClass: string | null) {
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode ? nameNode.text : 'Anonymous';
      const body = node.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkCpp(child, className);
        }
      }
      return;
    }

    if (node.type === 'function_definition') {
      const decl = node.childForFieldName('declarator');
      const unwrap = unwrapCppDeclarator(decl);
      let funcName = unwrap ? unwrap.name : 'anonymous';
      if (currentClass && !funcName.includes('.')) {
        funcName = `${currentClass}.${funcName}`;
      }
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const signature = getSignature(startLine);
      const body = node.childForFieldName('body');
      const calls = body ? extractCalls(body) : [];
      functions.push({ name: funcName, startLine, endLine, signature, calls });
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) walkCpp(child, null);
        }
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkCpp(child, currentClass);
    }
  }

  if (spec.langId === 'python') {
    walkPython(tree.rootNode, null);
  } else if (['javascript', 'typescript', 'tsx'].includes(spec.langId)) {
    walkJsTs(tree.rootNode, null);
  } else if (['c', 'cpp'].includes(spec.langId)) {
    walkCpp(tree.rootNode, null);
  }

  return {
    supported: true,
    language: spec.langId,
    functions,
  };
}
