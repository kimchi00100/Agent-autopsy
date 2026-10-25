import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFunctions } from '../src/localization/function-extractor.js';
import { locateChangeScope, locateCandidates } from '../src/localization/change-localizer.js';
import { packChangeScope, packChangeScopeFromScope } from '../src/localization/context-packer.js';
import { GitEngine } from '../src/git/git-engine.js';
import { CoreManager } from '../src/core-manager.js';
import { getAgentsMdTemplate } from '../src/core/project.js';

describe('B-1a: Function Boundary Extractor (function-extractor)', () => {
  test('Python extraction with decorators, class methods, and nested functions', async () => {
    const code = [
      '@route("/api")',
      'def handle_request(req):',
      '    log(req)',
      '    return process(req)',
      '',
      'class Shop:',
      '    def __init__(self, name):',
      '        self.name = name',
      '',
      '    def checkout(self, cart):',
      '        def calc_tax(total):',
      '            return total * 0.1',
      '        return calc_tax(cart.total())',
    ].join('\n');

    const res = await extractFunctions('shop.py', code);
    assert.equal(res.supported, true);
    assert.equal(res.language, 'python');
    assert.equal(res.functions.length, 4);

    // 1. handle_request
    assert.deepEqual(res.functions[0], {
      name: 'handle_request',
      startLine: 1,
      endLine: 4,
      signature: 'def handle_request(req):',
      calls: ['log', 'process'],
    });

    // 2. Shop.__init__
    assert.deepEqual(res.functions[1], {
      name: 'Shop.__init__',
      startLine: 7,
      endLine: 8,
      signature: 'def __init__(self, name):',
      calls: [],
    });

    // 3. Shop.checkout
    assert.deepEqual(res.functions[2], {
      name: 'Shop.checkout',
      startLine: 10,
      endLine: 13,
      signature: 'def checkout(self, cart):',
      calls: ['calc_tax', 'total'],
    });

    // 4. calc_tax
    assert.deepEqual(res.functions[3], {
      name: 'calc_tax',
      startLine: 11,
      endLine: 12,
      signature: 'def calc_tax(total):',
      calls: [],
    });
  });

  test('TypeScript / JavaScript extraction with classes, arrows, and nested functions', async () => {
    const code = [
      'class OrderService {',
      '  constructor(private db: Database) {}',
      '',
      '  processOrder(orderId: string): boolean {',
      '    const valid = validateOrder(orderId);',
      '    return valid;',
      '  }',
      '',
      '  cancelOrder = (orderId: string) => {',
      '    this.notify(orderId);',
      '  };',
      '}',
      '',
      'const calculateTotal = (items: number[]): number => {',
      '  return sum(items);',
      '};',
      '',
      'function runBatch(): void {',
      '  function step(): void {',
      '    logStep();',
      '  }',
      '  step();',
      '}',
    ].join('\n');

    const res = await extractFunctions('order.ts', code);
    assert.equal(res.supported, true);
    assert.equal(res.language, 'typescript');
    assert.equal(res.functions.length, 6);

    assert.deepEqual(res.functions[0], {
      name: 'OrderService.constructor',
      startLine: 2,
      endLine: 2,
      signature: 'constructor(private db: Database) {}',
      calls: [],
    });

    assert.deepEqual(res.functions[1], {
      name: 'OrderService.processOrder',
      startLine: 4,
      endLine: 7,
      signature: 'processOrder(orderId: string): boolean {',
      calls: ['validateOrder'],
    });

    assert.deepEqual(res.functions[2], {
      name: 'OrderService.cancelOrder',
      startLine: 9,
      endLine: 11,
      signature: 'cancelOrder = (orderId: string) => {',
      calls: ['notify'],
    });

    assert.deepEqual(res.functions[3], {
      name: 'calculateTotal',
      startLine: 14,
      endLine: 16,
      signature: 'const calculateTotal = (items: number[]): number => {',
      calls: ['sum'],
    });

    assert.deepEqual(res.functions[4], {
      name: 'runBatch',
      startLine: 18,
      endLine: 23,
      signature: 'function runBatch(): void {',
      calls: ['step'],
    });

    assert.deepEqual(res.functions[5], {
      name: 'step',
      startLine: 19,
      endLine: 21,
      signature: 'function step(): void {',
      calls: ['logStep'],
    });
  });

  test('C/C++ extraction with class methods, out-of-line methods, and free functions', async () => {
    const code = [
      'class Calculator {',
      'public:',
      '  int add(int a, int b) {',
      '    return doAdd(a, b);',
      '  }',
      '  void reset();',
      '};',
      '',
      'void Calculator::reset() {',
      '  clearState();',
      '}',
      '',
      'int multiply(int x, int y) {',
      '  check(x, y);',
      '  return x * y;',
      '}',
    ].join('\n');

    const res = await extractFunctions('calc.cpp', code);
    assert.equal(res.supported, true);
    assert.equal(res.language, 'cpp');
    assert.equal(res.functions.length, 3);

    assert.deepEqual(res.functions[0], {
      name: 'Calculator.add',
      startLine: 3,
      endLine: 5,
      signature: 'int add(int a, int b) {',
      calls: ['doAdd'],
    });

    assert.deepEqual(res.functions[1], {
      name: 'Calculator.reset',
      startLine: 9,
      endLine: 11,
      signature: 'void Calculator::reset() {',
      calls: ['clearState'],
    });

    assert.deepEqual(res.functions[2], {
      name: 'multiply',
      startLine: 13,
      endLine: 16,
      signature: 'int multiply(int x, int y) {',
      calls: ['check'],
    });
  });

  test('Unsupported extensions return empty list without throwing', async () => {
    const res = await extractFunctions('README.md', '# Header\nSome markdown text');
    assert.equal(res.supported, false);
    assert.deepEqual(res.functions, []);
  });

  test('Empty files return empty list with supported=true', async () => {
    const resPy = await extractFunctions('empty.py', '');
    assert.equal(resPy.supported, true);
    assert.deepEqual(resPy.functions, []);

    const resTs = await extractFunctions('empty.ts', '');
    assert.equal(resTs.supported, true);
    assert.deepEqual(resTs.functions, []);

    const resCpp = await extractFunctions('empty.cpp', '');
    assert.equal(resCpp.supported, true);
    assert.deepEqual(resCpp.functions, []);
  });

  test('Syntax error files recover and extract surrounding valid functions', async () => {
    const brokenPy = [
      'def valid_first():',
      '    return 1',
      '',
      'def broken_func():',
      '    !@#$%^&*()',
      '',
      'def valid_second():',
      '    helper()',
      '    return 2',
    ].join('\n');

    const res = await extractFunctions('broken.py', brokenPy);
    assert.equal(res.supported, true);
    const names = res.functions.map((f) => f.name);
    assert.ok(names.includes('valid_first'));
    assert.ok(names.includes('valid_second'));

    const brokenTs = [
      'function validTs1() { return true; }',
      'class {{{ bad syntax here',
      'function validTs2() { log("ok"); }',
    ].join('\n');
    const resTs = await extractFunctions('broken.ts', brokenTs);
    assert.equal(resTs.supported, true);
    const namesTs = resTs.functions.map((f) => f.name);
    assert.ok(namesTs.includes('validTs1'));
    assert.ok(namesTs.includes('validTs2'));
  });
});

function createTempGitRepo(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_loc_test_'));
  execSync('git init', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
  return tempDir;
}

describe('B-1b: Change-based Candidate Localizer (change-localizer)', () => {
  const gitEngine = new GitEngine();

  test('기능 확인용(smoke): 12개 기본 예제', async () => {
    interface SmokeResult {
      name: string;
      lang: string;
      type: string;
      expected: string;
      inChanged: boolean;
      inNeighbor: boolean;
      inScope: boolean;
    }

    const results: SmokeResult[] = [];

    async function runCase(
      name: string,
      lang: string,
      type: string,
      setupFn: (repo: string) => void,
      modifyFn: (repo: string) => void,
      expectedGroundTruth: string | string[],
      isRipple = false,
      rippleUnchangedName = '',
      expectedRelatedTo = '',
      expectedRelation: 'CALLS' | 'CALLED_BY' | '' = ''
    ): Promise<void> {
      const repo = createTempGitRepo();
      try {
        setupFn(repo);
        execSync('git add . && git commit -m "baseline"', { cwd: repo, stdio: 'ignore' });
        modifyFn(repo);
        const res = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });

        const targets = Array.isArray(expectedGroundTruth) ? expectedGroundTruth : [expectedGroundTruth];
        const inChanged = res.changedFunctions.some((f) => targets.includes(f.name));
        const inNeighbor = res.neighborFunctions.some((f) => targets.includes(f.name));
        const inScope = inChanged || inNeighbor;

        assert.ok(inScope, `${name}: Ground truth must be in scope (changed or neighbor)`);

        if (isRipple && rippleUnchangedName) {
          const bNeighbor = res.neighborFunctions.find((f) => f.name === rippleUnchangedName);
          assert.ok(bNeighbor, `Ripple unchanged function ${rippleUnchangedName} must be in neighborFunctions`);
          assert.equal(bNeighbor.relatedTo, expectedRelatedTo, `Neighbor function must relate to ${expectedRelatedTo}`);
          assert.equal(bNeighbor.relation, expectedRelation, `Neighbor function relation must be ${expectedRelation}`);
        }

        results.push({
          name,
          lang,
          type,
          expected: targets.join(' / '),
          inChanged,
          inNeighbor,
          inScope,
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }

    // --- 1. Python Benchmarks ---
    // Py 1: 계산 착오
    await runCase(
      'Py 1 (계산 착오)', 'Python', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'pricing.py'), 'def calculate_discount(total_amount):\n    if total_amount > 100:\n        return total_amount * 0.10\n    return 0.0\n');
        fs.writeFileSync(path.join(repo, 'logger.py'), 'def log_event(level, msg):\n    prefix = "[APP]"\n    time = "now"\n    formatted = f"{prefix} [{time}] [{level}] {msg}"\n    print(formatted)\n    return True\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'pricing.py'), 'def calculate_discount(total_amount):\n    if total_amount > 100:\n        return 10\n    return 0.0\n');
        fs.writeFileSync(path.join(repo, 'logger.py'), 'def log_event(level, msg):\n    prefix = "[SYS]"\n    time = "now"\n    formatted = f"{prefix} [{time}] [{level}] {msg}"\n    print(formatted)\n    return True\n');
      },
      'calculate_discount'
    );

    // Py 2: 경계 조건
    await runCase(
      'Py 2 (경계 조건)', 'Python', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'game.py'), 'def is_in_range(target_dist, max_range):\n    if target_dist < 0:\n        return False\n    return target_dist <= max_range\n');
        fs.writeFileSync(path.join(repo, 'audio.py'), 'def set_volume(vol):\n    base = 100\n    min_v = 0\n    max_v = 200\n    return max(min_v, min(max_v, base + vol))\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'game.py'), 'def is_in_range(target_dist, max_range):\n    if target_dist < 0:\n        return False\n    return target_dist < max_range\n');
        fs.writeFileSync(path.join(repo, 'audio.py'), 'def set_volume(vol):\n    base = 90\n    min_v = 0\n    max_v = 200\n    return max(min_v, min(max_v, base + vol))\n');
      },
      'is_in_range'
    );

    // Py 3: 누락 (삭제만 있는 변경)
    await runCase(
      'Py 3 (누락)', 'Python', '누락',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'storage.py'), 'def serialize_profile(user):\n    data = {}\n    data["id"] = user.id\n    data["email"] = user.email\n    return data\n');
        fs.writeFileSync(path.join(repo, 'metrics.py'), 'def record_ping():\n    t = 1\n    count = 10\n    status = "OK"\n    return f"{status}:{t}"\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'storage.py'), 'def serialize_profile(user):\n    data = {}\n    data["id"] = user.id\n    return data\n');
        fs.writeFileSync(path.join(repo, 'metrics.py'), 'def record_ping():\n    t = 2\n    count = 10\n    status = "OK"\n    return f"{status}:{t}"\n');
      },
      'serialize_profile'
    );

    // Py 4: 파급
    await runCase(
      'Py 4 (파급)', 'Python', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'service.py'), 'def get_tax_rate(region):\n    if region == "US":\n        return 0.08\n    return 0.10\n');
        fs.writeFileSync(path.join(repo, 'checkout.py'), 'from service import get_tax_rate\n\ndef calculate_tax(amount, region):\n    rate = get_tax_rate(region)\n    return amount * rate\n');
        fs.writeFileSync(path.join(repo, 'other.py'), 'def other_metric():\n    tag = "base"\n    val = 10\n    return f"{tag}:{val}"\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'service.py'), 'def get_tax_rate(region):\n    if region == "US":\n        return {"standard": 0.08}\n    return {"standard": 0.10}\n');
        fs.writeFileSync(path.join(repo, 'other.py'), 'def other_metric():\n    tag = "prod"\n    val = 10\n    return f"{tag}:{val}"\n');
      },
      ['get_tax_rate', 'calculate_tax'],
      true,
      'calculate_tax',
      'get_tax_rate',
      'CALLS'
    );

    // --- 2. TypeScript Benchmarks ---
    // TS 1: 계산 착오
    await runCase(
      'TS 1 (계산 착오)', 'TypeScript', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'billing.ts'), 'export function applyCoupon(price: number): number {\n  if (price > 100) {\n    return price * 0.9;\n  }\n  return price;\n}\n');
        fs.writeFileSync(path.join(repo, 'telemetry.ts'), 'export function track(msg: string): void {\n  const p = "TAG";\n  const t = Date.now();\n  console.log(`[${t}] ${p} ${msg}`);\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'billing.ts'), 'export function applyCoupon(price: number): number {\n  if (price > 100) {\n    return price - 10;\n  }\n  return price;\n}\n');
        fs.writeFileSync(path.join(repo, 'telemetry.ts'), 'export function track(msg: string): void {\n  const p = "DEV";\n  const t = Date.now();\n  console.log(`[${t}] ${p} ${msg}`);\n}\n');
      },
      'applyCoupon'
    );

    // TS 2: 경계 조건
    await runCase(
      'TS 2 (경계 조건)', 'TypeScript', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'scheduler.ts'), 'export function hasSlot(current: number, max: number): boolean {\n  if (current < 0) return false;\n  return current <= max;\n}\n');
        fs.writeFileSync(path.join(repo, 'notifier.ts'), 'export function notify(): string {\n  const channel = "email";\n  const retries = 3;\n  return `${channel}:${retries}`;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'scheduler.ts'), 'export function hasSlot(current: number, max: number): boolean {\n  if (current < 0) return false;\n  return current < max;\n}\n');
        fs.writeFileSync(path.join(repo, 'notifier.ts'), 'export function notify(): string {\n  const channel = "sms";\n  const retries = 3;\n  return `${channel}:${retries}`;\n}\n');
      },
      'hasSlot'
    );

    // TS 3: 누락 (삭제만 있는 변경)
    await runCase(
      'TS 3 (누락)', 'TypeScript', '누락',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'session.ts'), 'export function createSession(user: any): any {\n  const s = {\n    id: user.id,\n    role: user.role,\n  };\n  return s;\n}\n');
        fs.writeFileSync(path.join(repo, 'analytics.ts'), 'export function ping(): string {\n  const h = "127.0.0.1";\n  const port = 80;\n  return `${h}:${port}`;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'session.ts'), 'export function createSession(user: any): any {\n  const s = {\n    id: user.id,\n  };\n  return s;\n}\n');
        fs.writeFileSync(path.join(repo, 'analytics.ts'), 'export function ping(): string {\n  const h = "localhost";\n  const port = 80;\n  return `${h}:${port}`;\n}\n');
      },
      'createSession'
    );

    // TS 4: 파급
    await runCase(
      'TS 4 (파급)', 'TypeScript', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'auth.ts'), 'export function verifyCredentials(token: string): string {\n  return "user-123";\n}\n');
        fs.writeFileSync(path.join(repo, 'api.ts'), 'import { verifyCredentials } from "./auth.js";\nexport function handleRequest(token: string): string {\n  const userId = verifyCredentials(token);\n  return "Hello " + userId;\n}\n');
        fs.writeFileSync(path.join(repo, 'health.ts'), 'export function health(): string {\n  const status = "UP";\n  const code = 200;\n  return `${status}:${code}`;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'auth.ts'), 'export function verifyCredentials(token: string): any {\n  return { uid: "user-123" };\n}\n');
        fs.writeFileSync(path.join(repo, 'health.ts'), 'export function health(): string {\n  const status = "OK";\n  const code = 200;\n  return `${status}:${code}`;\n}\n');
      },
      ['verifyCredentials', 'handleRequest'],
      true,
      'handleRequest',
      'verifyCredentials',
      'CALLS'
    );

    // --- 3. C++ Benchmarks ---
    // CPP 1: 계산 착오
    await runCase(
      'C++ 1 (계산 착오)', 'C++', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'discount.cpp'), 'double calculateDiscount(double amount) {\n  if (amount > 100.0) {\n    return amount * 0.10;\n  }\n  return 0.0;\n}\n');
        fs.writeFileSync(path.join(repo, 'logger.cpp'), 'void logMsg(const char* s) {\n  const char* tag = "INFO";\n  int code = 100;\n  printf("%s:%d", tag, code);\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'discount.cpp'), 'double calculateDiscount(double amount) {\n  if (amount > 100.0) {\n    return 10.0;\n  }\n  return 0.0;\n}\n');
        fs.writeFileSync(path.join(repo, 'logger.cpp'), 'void logMsg(const char* s) {\n  const char* tag = "WARN";\n  int code = 100;\n  printf("%s:%d", tag, code);\n}\n');
      },
      'calculateDiscount'
    );

    // CPP 2: 경계 조건
    await runCase(
      'C++ 2 (경계 조건)', 'C++', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'queue.cpp'), 'bool canPush(int current, int capacity) {\n  if (current < 0) return false;\n  return current <= capacity;\n}\n');
        fs.writeFileSync(path.join(repo, 'tracer.cpp'), 'int getTraceId() {\n  int base = 1000;\n  int salt = 42;\n  return base + salt;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'queue.cpp'), 'bool canPush(int current, int capacity) {\n  if (current < 0) return false;\n  return current < capacity;\n}\n');
        fs.writeFileSync(path.join(repo, 'tracer.cpp'), 'int getTraceId() {\n  int base = 2000;\n  int salt = 42;\n  return base + salt;\n}\n');
      },
      'canPush'
    );

    // CPP 3: 누락 (삭제만 있는 변경)
    await runCase(
      'C++ 3 (누락)', 'C++', '누락',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'state.cpp'), 'void serializeState(State* s, Buffer* out) {\n  out->writeInt(s->id);\n  out->writeInt(s->checksum);\n}\n');
        fs.writeFileSync(path.join(repo, 'bench.cpp'), 'void runBench() {\n  int iter = 100;\n  int warm = 10;\n  int flag = 1;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'state.cpp'), 'void serializeState(State* s, Buffer* out) {\n  out->writeInt(s->id);\n}\n');
        fs.writeFileSync(path.join(repo, 'bench.cpp'), 'void runBench() {\n  int iter = 200;\n  int warm = 10;\n  int flag = 1;\n}\n');
      },
      'serializeState'
    );

    // CPP 4: 파급
    await runCase(
      'C++ 4 (파급)', 'C++', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'fetcher.cpp'), 'int fetchStatus(int code) {\n  return code * 2;\n}\n');
        fs.writeFileSync(path.join(repo, 'controller.cpp'), 'int fetchStatus(int code);\nvoid processJob() {\n  int st = fetchStatus(10);\n  notify(st);\n}\n');
        fs.writeFileSync(path.join(repo, 'utils.cpp'), 'void helper() {\n  int a = 1;\n  int b = 2;\n  int c = 3;\n}\n');
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'fetcher.cpp'), 'int fetchStatus(int code) {\n  return code + 100;\n}\n');
        fs.writeFileSync(path.join(repo, 'utils.cpp'), 'void helper() {\n  int a = 9;\n  int b = 2;\n  int c = 3;\n}\n');
      },
      ['fetchStatus', 'processJob'],
      true,
      'processJob',
      'fetchStatus',
      'CALLS'
    );

    console.log('\n=================== 기능 확인용(smoke) 12개 기본 예제 ===================');
    console.table(
      results.map((r) => ({
        예제: r.name,
        언어: r.lang,
        유형: r.type,
        '기대 정답': r.expected,
        'changed 포함': r.inChanged ? 'O' : 'X',
        'neighbor 포함': r.inNeighbor ? 'O' : 'X',
        '범위 포함 여부': r.inScope ? 'O' : 'X',
      }))
    );
    console.log(`기능 확인용(smoke) 예제 완료: ${results.length}개 (정확도 집계 제외)`);
  });

  test('현실적 정확도 벤치마크: 9개 예제 (언어별 3개, 파일 6개 이상, 함수 20개 이상)', async () => {
    interface RealisticResult {
      name: string;
      lang: string;
      type: string;
      totalRepoFunctions: number;
      changedCount: number;
      neighborCount: number;
      scopeCount: number;
      inScope: boolean;
      location: string;
      reductionRatio: number;
    }

    const results: RealisticResult[] = [];

    async function runRealisticCase(
      name: string,
      lang: string,
      type: string,
      setupFn: (repo: string) => void,
      modifyFn: (repo: string) => void,
      expectedGroundTruth: string | string[]
    ): Promise<void> {
      const repo = createTempGitRepo();
      try {
        setupFn(repo);
        execSync('git add . && git commit -m "initial baseline"', { cwd: repo, stdio: 'ignore' });
        modifyFn(repo);

        const res = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
        const targets = Array.isArray(expectedGroundTruth) ? expectedGroundTruth : [expectedGroundTruth];

        const inChanged = res.changedFunctions.some((f) => targets.includes(f.name));
        const inNeighbor = res.neighborFunctions.some((f) => targets.includes(f.name));
        const inScope = inChanged || inNeighbor;

        let location = '범위 밖';
        if (inChanged && inNeighbor) location = 'changed + neighbor';
        else if (inChanged) location = 'changed';
        else if (inNeighbor) location = 'neighbor';

        results.push({
          name,
          lang,
          type,
          totalRepoFunctions: res.scopeStats.totalRepoFunctions,
          changedCount: res.scopeStats.changedFunctionCount,
          neighborCount: res.scopeStats.neighborFunctionCount,
          scopeCount: res.scopeStats.scopeFunctionCount,
          inScope,
          location,
          reductionRatio: res.scopeStats.reductionRatio,
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }

    // =========================================================================
    // 1. Python Case 1: E-Commerce Order & Tier Discount
    // =========================================================================
    await runRealisticCase(
      'Py-R1 (주문 할인 추가)', 'Python', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'models.py'), `
def create_order(user_id, items):
    return {"user_id": user_id, "items": items, "status": "PENDING"}

def calculate_subtotal(items):
    total = 0
    for it in items:
        total += it.get("price", 0) * it.get("qty", 1)
    return total

def apply_tax(subtotal, rate=0.08):
    return round(subtotal * rate, 2)
`);
        fs.writeFileSync(path.join(repo, 'inventory.py'), `
def check_stock(item_id, qty):
    return qty <= 100

def reserve_stock(order_id, items):
    for it in items:
        if not check_stock(it["id"], it["qty"]):
            return False
    return True

def release_stock(order_id):
    return True

def update_reorder_level(item_id, min_qty):
    return min_qty > 0
`);
        fs.writeFileSync(path.join(repo, 'discounts.py'), `
def evaluate_promo_code(code, total):
    if code == "SUMMER":
        return total * 0.05
    return 0.0

def calculate_tier_discount(tier, total):
    if tier == "GOLD":
        return total * 0.15
    elif tier == "SILVER":
        return total * 0.08
    return 0.0

def validate_coupon_expiry(expiry_date, today):
    return expiry_date >= today
`);
        fs.writeFileSync(path.join(repo, 'payment.py'), `
def process_card_payment(card_token, amount):
    if amount <= 0:
        return False
    return True

def format_receipt(order_id, subtotal, discount, total):
    lines = [f"Order: {order_id}", f"Subtotal: {subtotal}", f"Discount: {discount}", f"Total: {total}"]
    return "\\n".join(lines)

def record_transaction_log(tx_id, status, amount):
    return {"tx_id": tx_id, "status": status, "amount": amount}
`);
        fs.writeFileSync(path.join(repo, 'notifications.py'), `
def send_order_confirmation(email, order_id):
    msg = f"Order {order_id} confirmed."
    return True

def format_sms_template(phone, order_id):
    return f"Order {order_id} placed."

def queue_email_job(email, subject, body):
    return {"queued": True, "to": email}
`);
        fs.writeFileSync(path.join(repo, 'service.py'), `
from models import create_order, calculate_subtotal, apply_tax
from inventory import reserve_stock
from discounts import evaluate_promo_code, calculate_tier_discount
from payment import process_card_payment, format_receipt
from notifications import send_order_confirmation

def validate_order_request(req):
    if not req.get("user_id"):
        return False
    if not req.get("items"):
        return False
    return True

def checkout_workflow(req):
    if not validate_order_request(req):
        return {"error": "INVALID_REQUEST"}
    subtotal = calculate_subtotal(req["items"])
    disc = calculate_tier_discount(req.get("tier", "NORMAL"), subtotal)
    tax = apply_tax(subtotal - disc)
    net_total = subtotal - disc + tax
    if not reserve_stock("ord-1", req["items"]):
        return {"error": "OUT_OF_STOCK"}
    if not process_card_payment(req.get("card_token"), net_total):
        return {"error": "PAYMENT_FAILED"}
    send_order_confirmation(req.get("email"), "ord-1")
    return {"order_id": "ord-1", "total": net_total}

def cancel_order_workflow(order_id):
    return True
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'service.py'), `
from models import create_order, calculate_subtotal, apply_tax
from inventory import reserve_stock
from discounts import evaluate_promo_code, calculate_tier_discount
from payment import process_card_payment, format_receipt
from notifications import send_order_confirmation

def validate_order_request(req):
    if not req.get("user_id"):
        return False
    if not req.get("items"):
        return False
    tier = req.get("tier", "NORMAL")
    if tier not in ["NORMAL", "SILVER", "GOLD", "VIP"]:
        return False
    return True

def checkout_workflow(req):
    if not validate_order_request(req):
        return {"error": "INVALID_REQUEST"}
    subtotal = calculate_subtotal(req["items"])
    tier = req.get("tier", "NORMAL")
    promo_code = req.get("promo")
    disc = calculate_tier_discount(tier, subtotal)
    if promo_code:
        disc += evaluate_promo_code(promo_code, subtotal)
    tax = apply_tax(subtotal - disc)
    net_total = max(0.0, subtotal - disc + tax)
    if not reserve_stock("ord-1", req["items"]):
        return {"error": "OUT_OF_STOCK"}
    if not process_card_payment(req.get("card_token"), net_total, req.get("currency", "USD")):
        return {"error": "PAYMENT_FAILED"}
    receipt = format_receipt("ord-1", subtotal, disc, net_total, tier)
    send_order_confirmation(req.get("email"), "ord-1", receipt)
    return {"order_id": "ord-1", "total": net_total}

def cancel_order_workflow(order_id):
    return True
`);
        fs.writeFileSync(path.join(repo, 'discounts.py'), `
def evaluate_promo_code(code, total):
    if code == "SUMMER":
        return total * 0.05
    elif code == "WELCOME2026":
        return min(25.0, total * 0.10)
    return 0.0

def calculate_tier_discount(tier, total):
    if tier == "VIP":
        return total - 0.20
    elif tier == "GOLD":
        return total * 0.15
    elif tier == "SILVER":
        return total * 0.08
    return 0.0

def validate_coupon_expiry(expiry_date, today):
    return expiry_date >= today
`);
        fs.writeFileSync(path.join(repo, 'payment.py'), `
def process_card_payment(card_token, amount, currency="USD"):
    if amount <= 0:
        return False
    if not card_token or len(card_token) < 5:
        return False
    return True

def format_receipt(order_id, subtotal, discount, total, tier="NORMAL"):
    lines = [
        f"Order: {order_id}",
        f"Tier: {tier}",
        f"Subtotal: {subtotal}",
        f"Discount: {discount}",
        f"Total: {total}"
    ]
    return "\\n".join(lines)

def record_transaction_log(tx_id, status, amount):
    return {"tx_id": tx_id, "status": status, "amount": amount}
`);
        fs.writeFileSync(path.join(repo, 'notifications.py'), `
def send_order_confirmation(email, order_id, receipt=""):
    msg = f"Order {order_id} confirmed."
    if receipt:
        msg += f"\\nReceipt details:\\n{receipt}"
    return True

def format_sms_template(phone, order_id):
    return f"Order {order_id} placed."

def queue_email_job(email, subject, body):
    return {"queued": True, "to": email}
`);
      },
      'calculate_tier_discount'
    );

    // =========================================================================
    // 2. Python Case 2: Task Workflow & Exponential Backoff
    // =========================================================================
    await runRealisticCase(
      'Py-R2 (작업 재시도 정책 추가)', 'Python', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'task.py'), `
def create_task(task_id, payload):
    return {"id": task_id, "payload": payload, "status": "READY"}

def serialize_task(task):
    import json
    return json.dumps(task)

def deserialize_task(raw_str):
    import json
    return json.loads(raw_str)

def validate_task_payload(payload):
    return isinstance(payload, dict) and "action" in payload
`);
        fs.writeFileSync(path.join(repo, 'queue_mgr.py'), `
def enqueue_task(queue, task):
    queue.append(task)
    return len(queue)

def dequeue_task(queue):
    if not queue:
        return None
    return queue.pop(0)

def peek_queue(queue):
    return queue[0] if queue else None

def purge_completed(tasks):
    return [t for t in tasks if t.get("status") != "DONE"]
`);
        fs.writeFileSync(path.join(repo, 'executor.py'), `
def execute_job(task):
    if not task:
        return False
    return True

def handle_failure(task, err, attempts):
    return {"failed": True, "attempts": attempts, "error": str(err)}

def record_metric(name, val):
    return {name: val}

def format_error_trace(err):
    return f"ERROR: {err}"
`);
        fs.writeFileSync(path.join(repo, 'retry.py'), `
def should_retry(attempts, max_attempts):
    return attempts <= max_attempts

def calculate_backoff(attempts, base_delay):
    return base_delay * (2 ** attempts)

def get_max_attempts(priority):
    if priority == "HIGH":
        return 5
    return 3
`);
        fs.writeFileSync(path.join(repo, 'storage.py'), `
def save_task_state(task_id, state):
    return True

def load_task_state(task_id):
    return {"status": "READY"}

def archive_old_tasks(days):
    return 0
`);
        fs.writeFileSync(path.join(repo, 'coordinator.py'), `
from task import create_task, serialize_task
from queue_mgr import enqueue_task, dequeue_task
from executor import execute_job, handle_failure
from retry import should_retry, calculate_backoff

def poll_cycle(queue):
    task = dequeue_task(queue)
    if not task:
        return False
    return True

def dispatch_batch(batch, queue):
    for item in batch:
        enqueue_task(queue, item)
    return len(batch)

def drain_worker_pool(workers):
    return True
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'task.py'), `
def create_task(task_id, payload, priority="NORMAL", retry_policy=None):
    return {
        "id": task_id,
        "payload": payload,
        "priority": priority,
        "retry_policy": retry_policy or {"max_retries": 3, "base_delay": 1.0},
        "status": "READY"
    }

def serialize_task(task):
    import json
    data = {**task, "v": 2}
    return json.dumps(data)

def deserialize_task(raw_str):
    import json
    return json.loads(raw_str)

def validate_task_payload(payload):
    return isinstance(payload, dict) and "action" in payload
`);
        fs.writeFileSync(path.join(repo, 'queue_mgr.py'), `
def enqueue_task(queue, task, front=False):
    if front:
        queue.insert(0, task)
    else:
        queue.append(task)
    return len(queue)

def dequeue_task(queue):
    if not queue:
        return None
    return queue.pop(0)

def peek_queue(queue):
    return queue[0] if queue else None

def purge_completed(tasks):
    return [t for t in tasks if t.get("status") != "DONE"]
`);
        fs.writeFileSync(path.join(repo, 'coordinator.py'), `
from task import create_task, serialize_task
from queue_mgr import enqueue_task, dequeue_task
from executor import execute_job, handle_failure
from retry import should_retry, calculate_backoff

def poll_cycle(queue, delay_queue=None):
    task = dequeue_task(queue)
    if not task:
        return False
    ok = execute_job(task, task.get("retry_policy"))
    return ok

def dispatch_batch(batch, queue, priority="NORMAL"):
    count = 0
    for item in batch:
        t = create_task(item["id"], item, priority=priority)
        enqueue_task(queue, t, front=(priority == "HIGH"))
        count += 1
    return count

def drain_worker_pool(workers):
    return True
`);
        fs.writeFileSync(path.join(repo, 'executor.py'), `
def execute_job(task, policy=None):
    if not task:
        return False
    task["status"] = "RUNNING"
    task["attempts"] = task.get("attempts", 0) + 1
    return True

def handle_failure(task, err, attempts):
    return {"failed": True, "attempts": attempts, "error": str(err)}

def record_metric(name, val):
    return {name: val}

def format_error_trace(err):
    return f"ERROR: {err}"
`);
        fs.writeFileSync(path.join(repo, 'retry.py'), `
def should_retry(attempts, max_attempts):
    if attempts < 0:
        return False
    return attempts < max_attempts - 1

def calculate_backoff(attempts, base_delay, jitter=0.1):
    delay = base_delay * (2 ** attempts)
    return delay + (delay * jitter)

def get_max_attempts(priority):
    if priority == "HIGH":
        return 5
    return 3
`);
      },
      'should_retry'
    );

    // =========================================================================
    // 3. Python Case 3: Authentication & Multi-Role Permissions (Ripple)
    // =========================================================================
    await runRealisticCase(
      'Py-R3 (다중 역할 권한 분기)', 'Python', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'auth.py'), `
def verify_password(plain, hashed):
    return plain == hashed

def hash_password(plain):
    return f"hash:{plain}"

def generate_session_token(user_id):
    return f"token_{user_id}_standard"

def validate_token_header(header):
    if not header or not header.startswith("Bearer "):
        return None
    return header[7:]
`);
        fs.writeFileSync(path.join(repo, 'permissions.py'), `
def get_user_roles(user_id):
    return "USER"

def check_role_access(user_id, required_role):
    role = get_user_roles(user_id)
    return role == required_role

def assign_role(user_id, new_role):
    return True

def has_admin_flag(user_id):
    return False
`);
        fs.writeFileSync(path.join(repo, 'user_store.py'), `
def find_user_by_id(user_id):
    return {"id": user_id, "name": "Alice"}

def update_user_profile(user_id, data):
    return True

def record_login_timestamp(user_id, ts):
    return ts
`);
        fs.writeFileSync(path.join(repo, 'session.py'), `
def create_session_record(token, user_id):
    return {"token": token, "uid": user_id}

def get_active_session(token):
    return {"token": token, "valid": True}

def invalidate_session(token):
    return True
`);
        fs.writeFileSync(path.join(repo, 'audit.py'), `
def log_security_event(event_type, user_id):
    return f"{event_type}:{user_id}"

def format_audit_entry(event_type, details):
    return f"AUDIT: {event_type} - {details}"

def sanitize_log_data(data):
    return str(data)
`);
        fs.writeFileSync(path.join(repo, 'api.py'), `
from auth import generate_session_token, validate_token_header
from permissions import check_role_access, get_user_roles
from user_store import find_user_by_id
from session import create_session_record
from audit import log_security_event

def login_endpoint(user_id, password):
    token = generate_session_token(user_id)
    create_session_record(token, user_id)
    log_security_event("LOGIN", user_id)
    return {"token": token}

def profile_endpoint(header):
    token = validate_token_header(header)
    if not token:
        return {"error": "UNAUTHORIZED"}
    return find_user_by_id("uid-1")

def logout_endpoint(token):
    return {"ok": True}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'permissions.py'), `
def get_user_roles(user_id):
    if user_id == "admin":
        return ["ADMIN", "USER"]
    return ["USER"]

def check_role_access(user_id, required_role):
    role = get_user_roles(user_id)
    return role == required_role

def assign_role(user_id, new_role):
    roles = ["USER", new_role]
    return roles

def has_admin_flag(user_id):
    return "ADMIN" in get_user_roles(user_id)
`);
        fs.writeFileSync(path.join(repo, 'auth.py'), `
def verify_password(plain, hashed):
    return plain == hashed

def hash_password(plain):
    return f"hash:{plain}"

def generate_session_token(user_id, roles=None):
    r_str = ",".join(roles or ["USER"])
    return f"token_{user_id}_{r_str}"

def validate_token_header(header, expected_scheme="Bearer "):
    if not header or not header.startswith(expected_scheme):
        return None
    return header[len(expected_scheme):]
`);
        fs.writeFileSync(path.join(repo, 'user_store.py'), `
def find_user_by_id(user_id):
    return {"id": user_id, "name": "Alice"}

def update_user_profile(user_id, data):
    roles = data.get("roles", [])
    return len(roles) > 0

def record_login_timestamp(user_id, ts):
    return ts
`);
        fs.writeFileSync(path.join(repo, 'audit.py'), `
def log_security_event(event_type, user_id, extra=None):
    entry = f"{event_type}:{user_id}"
    if extra:
        entry += f" metadata={extra}"
    return entry

def format_audit_entry(event_type, details):
    return f"AUDIT: {event_type} - {details}"

def sanitize_log_data(data):
    return str(data)
`);
        fs.writeFileSync(path.join(repo, 'api.py'), `
from auth import generate_session_token, validate_token_header
from permissions import check_role_access, get_user_roles
from user_store import find_user_by_id
from session import create_session_record
from audit import log_security_event

def login_endpoint(user_id, password):
    roles = get_user_roles(user_id)
    token = generate_session_token(user_id, roles)
    create_session_record(token, user_id)
    log_security_event("LOGIN", user_id, {"roles": roles})
    return {"token": token, "roles": roles}

def profile_endpoint(header):
    token = validate_token_header(header)
    if not token:
        return {"error": "UNAUTHORIZED"}
    return find_user_by_id("uid-1")

def logout_endpoint(token):
    return {"ok": True}
`);
      },
      ['get_user_roles', 'check_role_access']
    );

    // =========================================================================
    // 4. TypeScript Case 1: Subscription Billing Proration
    // =========================================================================
    await runRealisticCase(
      'TS-R1 (구독 일할 계산 추가)', 'TypeScript', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'subscription.ts'), `
export function createSubscription(userId: string, plan: string): any {
  return { userId, plan, status: 'ACTIVE', startDate: Date.now() };
}
export function renewSubscription(subId: string): boolean {
  return true;
}
export function cancelSubscription(subId: string): boolean {
  return true;
}
export function getPlanDetails(plan: string): { price: number; interval: string } {
  if (plan === 'PRO') return { price: 30, interval: 'month' };
  return { price: 10, interval: 'month' };
}
`);
        fs.writeFileSync(path.join(repo, 'pricing.ts'), `
export function calculateProration(oldPrice: number, newPrice: number, daysUsed: number, totalDays: number): number {
  const unusedRatio = Math.max(0, (totalDays - daysUsed) / totalDays);
  const credit = oldPrice * unusedRatio;
  const charge = newPrice * unusedRatio;
  return Math.round((charge - credit) * 100) / 100;
}
export function applySeasonalDiscount(amount: number, code: string): number {
  if (code === 'FALL') return amount * 0.9;
  return amount;
}
export function calculateVat(netAmount: number, rate = 0.2): number {
  return Math.round(netAmount * rate * 100) / 100;
}
export function getTierMultiplier(tier: string): number {
  return tier === 'ENTERPRISE' ? 0.85 : 1.0;
}
`);
        fs.writeFileSync(path.join(repo, 'invoice.ts'), `
export function generateInvoice(subId: string, amount: number, items: any[]): any {
  return { invoiceId: 'inv-1', subId, amount, items };
}
export function formatInvoicePdf(invoice: any): string {
  return 'PDF_BUFFER';
}
export function recordInvoiceHistory(invoiceId: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'customer.ts'), `
export function getCustomer(customerId: string): any {
  return { id: customerId, balance: 100, tier: 'STANDARD' };
}
export function updateCustomerBalance(customerId: string, delta: number): boolean {
  return true;
}
export function checkCreditLimit(customerId: string): boolean {
  return true;
}
export function sendNotification(customerId: string, message: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'paymentGateway.ts'), `
export function chargeCard(token: string, amount: number): boolean {
  return amount > 0;
}
export function refundCharge(chargeId: string, amount: number): boolean {
  return true;
}
export function verifyWebhookSignature(sig: string, body: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'billingService.ts'), `
import { createSubscription, getPlanDetails } from './subscription.js';
import { calculateProration, calculateVat } from './pricing.js';
import { generateInvoice } from './invoice.js';
import { getCustomer, updateCustomerBalance } from './customer.js';
import { chargeCard } from './paymentGateway.js';

export function validateBillingRequest(req: any): boolean {
  return Boolean(req.userId && req.plan);
}

export function processMonthlyBilling(req: any): any {
  if (!validateBillingRequest(req)) return { error: 'INVALID' };
  const plan = getPlanDetails(req.plan);
  const vat = calculateVat(plan.price);
  const total = plan.price + vat;
  chargeCard(req.paymentToken, total);
  const inv = generateInvoice('sub-1', total, [{ plan: req.plan, price: plan.price }]);
  updateCustomerBalance(req.userId, -total);
  return inv;
}

export function handlePaymentFailure(subId: string, err: string): void {
  console.error(subId, err);
}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'billingService.ts'), `
import { createSubscription, getPlanDetails } from './subscription.js';
import { calculateProration, calculateVat } from './pricing.js';
import { generateInvoice } from './invoice.js';
import { getCustomer, updateCustomerBalance } from './customer.js';
import { chargeCard } from './paymentGateway.js';

export function validateBillingRequest(req: any): boolean {
  if (!req.userId || !req.plan) return false;
  if (req.isUpgrade && (!req.oldPlan || req.daysUsed === undefined)) return false;
  return true;
}

export function processMonthlyBilling(req: any): any {
  if (!validateBillingRequest(req)) return { error: 'INVALID' };
  const newPlan = getPlanDetails(req.plan);
  let amountToCharge = newPlan.price;
  if (req.isUpgrade) {
    const oldPlan = getPlanDetails(req.oldPlan);
    const proration = calculateProration(oldPlan.price, newPlan.price, req.daysUsed, 30);
    amountToCharge = Math.max(0, proration);
  }
  const vat = calculateVat(amountToCharge, req.vatRate || 0.2);
  const total = amountToCharge + vat;
  chargeCard(req.paymentToken, total);
  const inv = generateInvoice('sub-1', total, [{ plan: req.plan, price: amountToCharge }], req.isUpgrade);
  updateCustomerBalance(req.userId, -total, req.isUpgrade ? 'UPGRADE' : 'RENEWAL');
  return inv;
}

export function handlePaymentFailure(subId: string, err: string): void {
  console.error(subId, err);
}
`);
        fs.writeFileSync(path.join(repo, 'pricing.ts'), `
export function calculateProration(oldPrice: number, newPrice: number, daysUsed: number, totalDays: number): number {
  const unusedRatio = Math.max(0, (365 - daysUsed) / 365);
  const credit = oldPrice * unusedRatio;
  const charge = newPrice * unusedRatio;
  return Math.round((charge - credit) * 100) / 100;
}
export function applySeasonalDiscount(amount: number, code: string): number {
  if (code === 'FALL') return amount * 0.9;
  return amount;
}
export function calculateVat(netAmount: number, rate = 0.2): number {
  const clampedRate = Math.min(0.3, Math.max(0, rate));
  return Math.round(netAmount * clampedRate * 100) / 100;
}
export function getTierMultiplier(tier: string): number {
  return tier === 'ENTERPRISE' ? 0.85 : 1.0;
}
`);
        fs.writeFileSync(path.join(repo, 'subscription.ts'), `
export function createSubscription(userId: string, plan: string, options: any = {}): any {
  return { userId, plan, status: 'ACTIVE', startDate: Date.now(), metadata: options };
}
export function renewSubscription(subId: string, nextCycleMonths = 1): boolean {
  return nextCycleMonths > 0;
}
export function cancelSubscription(subId: string): boolean {
  return true;
}
export function getPlanDetails(plan: string): { price: number; interval: string } {
  if (plan === 'PRO') return { price: 30, interval: 'month' };
  return { price: 10, interval: 'month' };
}
`);
        fs.writeFileSync(path.join(repo, 'invoice.ts'), `
export function generateInvoice(subId: string, amount: number, items: any[], isUpgrade = false): any {
  return { invoiceId: 'inv-1', subId, amount, items, tag: isUpgrade ? 'PRORATED' : 'STANDARD' };
}
export function formatInvoicePdf(invoice: any): string {
  return 'PDF_BUFFER';
}
export function recordInvoiceHistory(invoiceId: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'customer.ts'), `
export function getCustomer(customerId: string): any {
  return { id: customerId, balance: 100, tier: 'STANDARD' };
}
export function updateCustomerBalance(customerId: string, delta: number, reason = 'PAYMENT'): boolean {
  return Boolean(customerId && reason);
}
export function checkCreditLimit(customerId: string): boolean {
  return true;
}
export function sendNotification(customerId: string, message: string): boolean {
  return true;
}
`);
      },
      'calculateProration'
    );

    // =========================================================================
    // 5. TypeScript Case 2: Chat & Mention Notification
    // =========================================================================
    await runRealisticCase(
      'TS-R2 (멘션 푸시 필터링)', 'TypeScript', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'message.ts'), `
export function createMessage(senderId: string, text: string): any {
  return { senderId, text, timestamp: Date.now() };
}
export function sanitizeMessage(raw: string): string {
  return raw.trim();
}
export function formatMessagePayload(msg: any): string {
  return JSON.stringify(msg);
}
export function extractMentions(text: string): string[] {
  const matches = text.match(/@(\\w+)/g);
  return matches ? matches.map(m => m.slice(1)) : [];
}
`);
        fs.writeFileSync(path.join(repo, 'channel.ts'), `
export function joinChannel(channelId: string, userId: string): boolean {
  return true;
}
export function leaveChannel(channelId: string, userId: string): boolean {
  return true;
}
export function getChannelMembers(channelId: string): string[] {
  return ['user1', 'user2', 'user3'];
}
export function isUserMuted(channelId: string, userId: string): boolean {
  return false;
}
`);
        fs.writeFileSync(path.join(repo, 'presence.ts'), `
export function updateUserPresence(userId: string, status: string): void {}
export function getUserStatus(userId: string): string {
  return 'ONLINE';
}
export function broadcastPresenceChange(userId: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'pushService.ts'), `
export function sendPushNotification(targetUserId: string, title: string, body: string): boolean {
  return Boolean(targetUserId && body);
}
export function formatPushBadge(unreadCount: number): number {
  return Math.max(0, unreadCount);
}
export function filterSilentHours(hour: number, startHour: number, endHour: number): boolean {
  return hour >= startHour && hour <= endHour;
}
`);
        fs.writeFileSync(path.join(repo, 'rateLimiter.ts'), `
export function checkRateLimit(userId: string): boolean {
  return true;
}
export function recordUserAction(userId: string): void {}
export function resetLimits(userId: string): void {}
`);
        fs.writeFileSync(path.join(repo, 'chatRouter.ts'), `
import { createMessage, extractMentions, formatMessagePayload } from './message.js';
import { getChannelMembers, isUserMuted } from './channel.js';
import { sendPushNotification, filterSilentHours } from './pushService.js';
import { checkRateLimit, recordUserAction } from './rateLimiter.js';

export function handleIncomingMessage(sender: string, text: string, channel: string): any {
  if (!checkRateLimit(sender)) return { error: 'RATE_LIMIT' };
  recordUserAction(sender);
  const msg = createMessage(sender, text);
  return msg;
}

export function dispatchToChannel(channel: string, msg: any): number {
  const members = getChannelMembers(channel);
  return members.length;
}

export function handleDirectMessage(sender: string, target: string, text: string): boolean {
  return true;
}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'message.ts'), `
export function createMessage(senderId: string, text: string, options: any = {}): any {
  const mentions = extractMentions(text);
  return { senderId, text, timestamp: Date.now(), mentions, priority: options.priority || 'NORMAL' };
}
export function sanitizeMessage(raw: string): string {
  return raw.trim();
}
export function formatMessagePayload(msg: any): string {
  const payload = { ...msg, formatted: true, mentionCount: msg.mentions?.length || 0 };
  return JSON.stringify(payload);
}
export function extractMentions(text: string): string[] {
  const matches = text.match(/@(\\w+)/g);
  return matches ? matches.map(m => m.slice(1)) : [];
}
`);
        fs.writeFileSync(path.join(repo, 'chatRouter.ts'), `
import { createMessage, extractMentions, formatMessagePayload } from './message.js';
import { getChannelMembers, isUserMuted } from './channel.js';
import { sendPushNotification, filterSilentHours } from './pushService.js';
import { checkRateLimit, recordUserAction } from './rateLimiter.js';

export function handleIncomingMessage(sender: string, text: string, channel: string): any {
  if (!checkRateLimit(sender)) return { error: 'RATE_LIMIT' };
  recordUserAction(sender, 'MESSAGE');
  const msg = createMessage(sender, text, { priority: 'NORMAL' });
  dispatchToChannel(channel, msg);
  return msg;
}

export function dispatchToChannel(channel: string, msg: any): number {
  const members = getChannelMembers(channel);
  let notified = 0;
  for (const m of members) {
    if (m !== msg.senderId && !isUserMuted(channel, m)) {
      if (msg.mentions?.includes(m)) {
        const isSilent = filterSilentHours(23, 22, 7);
        if (!isSilent) {
          sendPushNotification(m, 'Mentioned in ' + channel, msg.text, 'MENTION');
          notified++;
        }
      }
    }
  }
  return notified;
}

export function handleDirectMessage(sender: string, target: string, text: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'pushService.ts'), `
export function sendPushNotification(targetUserId: string, title: string, body: string, category = 'DEFAULT'): boolean {
  return Boolean(targetUserId && body && category);
}
export function formatPushBadge(unreadCount: number): number {
  return Math.max(0, unreadCount);
}
export function filterSilentHours(hour: number, startHour: number, endHour: number): boolean {
  if (startHour > endHour) {
    return hour > startHour && hour < endHour;
  }
  return hour >= startHour && hour <= endHour;
}
`);
        fs.writeFileSync(path.join(repo, 'rateLimiter.ts'), `
export function checkRateLimit(userId: string): boolean {
  return true;
}
export function recordUserAction(userId: string, actionType = 'DEFAULT'): void {
  const key = userId + ':' + actionType;
}
export function resetLimits(userId: string): void {}
`);
      },
      'filterSilentHours'
    );

    // =========================================================================
    // 6. TypeScript Case 3: Export Pipeline & Transformation (Ripple)
    // =========================================================================
    await runRealisticCase(
      'TS-R3 (데이터 파이프라인 정규화)', 'TypeScript', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'parser.ts'), `
export function parseCsvRows(raw: string): string[][] {
  return raw.split('\\n').map(r => r.split(','));
}
export function parseJsonPayload(raw: string): any {
  return JSON.parse(raw);
}
export function validateSchema(records: any[]): boolean {
  return records.length > 0;
}
export function inferColumnTypes(headers: string[]): Record<string, string> {
  return {};
}
`);
        fs.writeFileSync(path.join(repo, 'transform.ts'), `
export function normalizeDates(dateStr: string): string {
  return dateStr.slice(0, 10);
}
export function cleanStrings(val: string): string {
  return val.trim();
}
export function maskSensitivePii(val: string): string {
  return '***';
}
export function aggregateMetrics(records: any[]): { count: number } {
  return { count: records.length };
}
`);
        fs.writeFileSync(path.join(repo, 'filter.ts'), `
import { normalizeDates } from './transform.js';

export function applyDateRangeFilter(records: any[], start: string, end: string): any[] {
  return records.filter(r => {
    const d = normalizeDates(r.date);
    return d >= start && d <= end;
  });
}
export function filterByStatus(records: any[], status: string): any[] {
  return records.filter(r => r.status === status);
}
export function deduplicateRecords(records: any[]): any[] {
  return records;
}
`);
        fs.writeFileSync(path.join(repo, 'exporter.ts'), `
export function exportToParquet(records: any[]): string {
  return 'PARQUET_BLOB';
}
export function exportToCsv(records: any[]): string {
  return 'csv_data';
}
export function generateExportHeader(cols: string[]): string {
  return cols.join(',');
}
`);
        fs.writeFileSync(path.join(repo, 'storage.ts'), `
export function uploadToBucket(bucket: string, key: string, data: string): boolean {
  return true;
}
export function generateSignedUrl(key: string): string {
  return 'https://storage/' + key;
}
export function cleanupTempFiles(files: string[]): void {}
`);
        fs.writeFileSync(path.join(repo, 'pipeline.ts'), `
import { parseCsvRows, validateSchema } from './parser.js';
import { normalizeDates, cleanStrings } from './transform.js';
import { applyDateRangeFilter } from './filter.js';
import { exportToCsv } from './exporter.js';
import { uploadToBucket } from './storage.js';

export function runExportPipeline(rawCsv: string, start: string, end: string): any {
  const rows = parseCsvRows(rawCsv);
  if (!validateSchema(rows)) return { error: 'EMPTY' };
  const records = rows.map(r => ({ date: r[0], name: cleanStrings(r[1] || '') }));
  const filtered = applyDateRangeFilter(records, start, end);
  const csvOut = exportToCsv(filtered);
  uploadToBucket('exports', 'report.csv', csvOut);
  return { count: filtered.length };
}

export function buildExportContext(jobId: string): any {
  return { jobId, ts: Date.now() };
}

export function notifyExportComplete(jobId: string): boolean {
  return true;
}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'pipeline.ts'), `
import { parseCsvRows, validateSchema } from './parser.js';
import { normalizeDates, cleanStrings, maskSensitivePii } from './transform.js';
import { applyDateRangeFilter } from './filter.js';
import { exportToCsv } from './exporter.js';
import { uploadToBucket } from './storage.js';

export function runExportPipeline(rawCsv: string, start: string, end: string, options: any = {}): any {
  const rows = parseCsvRows(rawCsv, options.delimiter || ',');
  if (!validateSchema(rows)) return { error: 'EMPTY' };
  const records = rows.map(r => ({
    date: r[0],
    name: cleanStrings(r[1] || ''),
    ssn: options.maskPii ? maskSensitivePii(r[2] || '') : r[2]
  }));
  const filtered = applyDateRangeFilter(records, start, end);
  const csvOut = exportToCsv(filtered, options.includeHeaders ?? true);
  uploadToBucket('exports', 'report_' + Date.now() + '.csv', csvOut, options.compression);
  return { count: filtered.length, exported: true };
}

export function buildExportContext(jobId: string, initiator = 'SYSTEM'): any {
  return { jobId, initiator, ts: Date.now(), mode: 'STREAM' };
}

export function notifyExportComplete(jobId: string): boolean {
  return true;
}
`);
        fs.writeFileSync(path.join(repo, 'transform.ts'), `
export function normalizeDates(dateStr: string): string {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '' : d.toISOString().replace(/T/, ' @ ');
}
export function cleanStrings(val: string): string {
  return val.trim();
}
export function maskSensitivePii(val: string): string {
  if (val.length < 4) return '***';
  return '***-' + val.slice(-4);
}
export function aggregateMetrics(records: any[]): { count: number } {
  return { count: records.length };
}
`);
        fs.writeFileSync(path.join(repo, 'parser.ts'), `
export function parseCsvRows(raw: string, delim = ','): string[][] {
  return raw.split('\\n').filter(Boolean).map(r => r.split(delim));
}
export function parseJsonPayload(raw: string): any {
  return JSON.parse(raw);
}
export function validateSchema(records: any[]): boolean {
  return records.length > 0;
}
export function inferColumnTypes(headers: string[]): Record<string, string> {
  return {};
}
`);
        fs.writeFileSync(path.join(repo, 'exporter.ts'), `
export function exportToParquet(records: any[]): string {
  return 'PARQUET_BLOB';
}
export function exportToCsv(records: any[], includeHeaders = true): string {
  const header = includeHeaders ? 'date,name,ssn\\n' : '';
  return header + 'csv_data';
}
export function generateExportHeader(cols: string[]): string {
  return cols.join(',');
}
`);
        fs.writeFileSync(path.join(repo, 'storage.ts'), `
export function uploadToBucket(bucket: string, key: string, data: string, compression = 'NONE'): boolean {
  return Boolean(bucket && key && data && compression);
}
export function generateSignedUrl(key: string): string {
  return 'https://storage/' + key;
}
export function cleanupTempFiles(files: string[]): void {}
`);
      },
      ['normalizeDates', 'applyDateRangeFilter']
    );

    // =========================================================================
    // 7. C++ Case 1: Physics Simulation & Spatial Collision
    // =========================================================================
    await runRealisticCase(
      'C++-R1 (물리 충돌 서브스텝 추가)', 'C++', '계산 착오',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'math_utils.cpp'), `
float vecDistance(float x1, float y1, float x2, float y2) {
  float dx = x2 - x1;
  float dy = y2 - y1;
  return sqrtf(dx*dx + dy*dy);
}
void vecNormalize(float* x, float* y) {
  float len = sqrtf((*x)*(*x) + (*y)*(*y));
  if (len > 0.0001f) { *x /= len; *y /= len; }
}
float clampFloat(float v, float minV, float maxV) {
  if (v < minV) return minV;
  if (v > maxV) return maxV;
  return v;
}
`);
        fs.writeFileSync(path.join(repo, 'collider.cpp'), `
bool checkAABBOverlap(float minA_x, float maxA_x, float minB_x, float maxB_x) {
  return (minA_x <= maxB_x && maxA_x >= minB_x);
}
float computeBoundingRadius(float w, float h) {
  return sqrtf(w*w + h*h) * 0.5f;
}
void resolvePenetration(float* vx, float* vy, float nx, float ny, float restitution) {
  float dot = (*vx) * nx + (*vy) * ny;
  float impulse = -(1.0f + restitution) * dot;
  *vx += impulse * nx;
  *vy += impulse * ny;
}
`);
        fs.writeFileSync(path.join(repo, 'grid.cpp'), `
void insertEntity(int entityId, int cellX, int cellY) {}
void removeEntity(int entityId) {}
int queryNearbyEntities(int cellX, int cellY, int* outIds, int maxOut) {
  return 0;
}
void rebuildGridCells() {}
`);
        fs.writeFileSync(path.join(repo, 'rigidbody.cpp'), `
void integrateVelocity(float* x, float* y, float vx, float vy, float dt) {
  *x += vx * dt;
  *y += vy * dt;
}
void applyForce(float* fx, float* fy, float ax, float ay) {
  *fx += ax;
  *fy += ay;
}
void dampVelocity(float* vx, float* vy, float damping) {
  *vx *= damping;
  *vy *= damping;
}
`);
        fs.writeFileSync(path.join(repo, 'broadphase.cpp'), `
int findPotentialPairs(int* pairsA, int* pairsB, int maxPairs) {
  return 0;
}
void sortGridEntries() {}
void clearGridPairs() {}
`);
        fs.writeFileSync(path.join(repo, 'world.cpp'), `
#include "collider.cpp"
#include "rigidbody.cpp"
#include "grid.cpp"

void stepSimulation(float dt) {
  float x = 0.0f, y = 0.0f, vx = 5.0f, vy = -2.0f;
  integrateVelocity(&x, &y, vx, vy, dt);
  resolvePenetration(&vx, &vy, 0.0f, 1.0f, 0.5f);
}
void updateWorldTransforms() {}
void cullInactiveBodies() {}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'world.cpp'), `
#include "collider.cpp"
#include "rigidbody.cpp"
#include "grid.cpp"

void stepSimulation(float dt) {
  const int SUBSTEPS = 4;
  float subDt = dt / (float)SUBSTEPS;
  float x = 0.0f, y = 0.0f, vx = 5.0f, vy = -2.0f;
  for (int i = 0; i < SUBSTEPS; i++) {
    integrateVelocity(&x, &y, vx, vy, subDt);
    resolvePenetration(&vx, &vy, 0.0f, 1.0f, 0.5f);
  }
}
void updateWorldTransforms(int activeFlags) {
  if (activeFlags > 0) cullInactiveBodies();
}
void cullInactiveBodies() {}
`);
        fs.writeFileSync(path.join(repo, 'collider.cpp'), `
bool checkAABBOverlap(float minA_x, float maxA_x, float minB_x, float maxB_x) {
  return (minA_x <= maxB_x && maxA_x >= minB_x);
}
float computeBoundingRadius(float w, float h) {
  return sqrtf(w*w + h*h) * 0.5f;
}
void resolvePenetration(float* vx, float* vy, float nx, float ny, float restitution) {
  float dot = (*vx) * nx + (*vy) * ny;
  float impulse = (1.0f - restitution) * dot;
  *vx += impulse * nx;
  *vy += impulse * ny;
}
`);
        fs.writeFileSync(path.join(repo, 'rigidbody.cpp'), `
void integrateVelocity(float* x, float* y, float vx, float vy, float dt) {
  *x += vx * dt;
  *y += vy * dt;
}
void applyForce(float* fx, float* fy, float ax, float ay, float mass) {
  if (mass > 0.001f) {
    *fx += ax / mass;
    *fy += ay / mass;
  }
}
void dampVelocity(float* vx, float* vy, float damping) {
  *vx *= damping;
  *vy *= damping;
}
`);
        fs.writeFileSync(path.join(repo, 'grid.cpp'), `
void insertEntity(int entityId, int cellX, int cellY) {}
void removeEntity(int entityId) {}
int queryNearbyEntities(int cellX, int cellY, int* outIds, int maxOut, float radius) {
  if (radius > 10.0f) return 0;
  return maxOut > 0 ? 1 : 0;
}
void rebuildGridCells() {}
`);
        fs.writeFileSync(path.join(repo, 'broadphase.cpp'), `
int findPotentialPairs(int* pairsA, int* pairsB, int maxPairs, int maxDistance) {
  sortGridEntries();
  return maxPairs > 10 ? 10 : maxPairs;
}
void sortGridEntries() {}
void clearGridPairs() {}
`);
      },
      'resolvePenetration'
    );

    // =========================================================================
    // 8. C++ Case 2: Network Protocol & CRC Buffer Validation
    // =========================================================================
    await runRealisticCase(
      'C++-R2 (패킷 버퍼 경계 검증)', 'C++', '경계 조건',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'buffer.cpp'), `
char* allocateChunk(int size) { return (char*)malloc(size); }
void freeChunk(char* ptr) { free(ptr); }
void writeUint32(char* buf, int* offset, unsigned int val) {
  memcpy(buf + *offset, &val, 4);
  *offset += 4;
}
unsigned int readUint32(const char* buf, int* offset) {
  unsigned int val;
  memcpy(&val, buf + *offset, 4);
  *offset += 4;
  return val;
}
`);
        fs.writeFileSync(path.join(repo, 'packet.cpp'), `
void serializeHeader(char* outBuf, int* offset, unsigned short type, unsigned short len) {
  memcpy(outBuf + *offset, &type, 2);
  *offset += 2;
  memcpy(outBuf + *offset, &len, 2);
  *offset += 2;
}
bool deserializeHeader(const char* inBuf, int* offset, unsigned short* type, unsigned short* len) {
  memcpy(type, inBuf + *offset, 2);
  *offset += 2;
  memcpy(len, inBuf + *offset, 2);
  *offset += 2;
  return true;
}
bool validatePacketCrc(const char* buf, int bufLen) {
  if (bufLen <= 4) return false;
  return true;
}
void setPacketFlags(char* header, unsigned char flags) {}
`);
        fs.writeFileSync(path.join(repo, 'crypto.cpp'), `
unsigned int computePacketChecksum(const char* data, int len) {
  unsigned int sum = 0;
  for (int i = 0; i < len; i++) sum += (unsigned char)data[i];
  return sum;
}
void xorMaskPayload(char* payload, int len, unsigned char key) {}
bool verifySessionHmac(const char* sig, int len) { return len == 32; }
`);
        fs.writeFileSync(path.join(repo, 'pool.cpp'), `
char* acquireBuffer(int minSize) { return allocateChunk(minSize); }
void releaseBuffer(char* buf) { freeChunk(buf); }
int getPoolCapacity() { return 64; }
void shrinkPool() {}
`);
        fs.writeFileSync(path.join(repo, 'socket.cpp'), `
int sendRawBytes(int sock, const char* data, int len) { return len; }
int receiveRawBytes(int sock, char* outBuf, int maxLen) { return 0; }
void flushSocketQueue(int sock) {}
`);
        fs.writeFileSync(path.join(repo, 'session.cpp'), `
#include "packet.cpp"
#include "buffer.cpp"
#include "socket.cpp"

bool handleIncomingPacket(int sock, const char* raw, int len) {
  if (!validatePacketCrc(raw, len)) return false;
  int offset = 0;
  unsigned short type, plen;
  deserializeHeader(raw, &offset, &type, &plen);
  return true;
}
bool queueOutgoingPacket(int sock, unsigned short type, const char* data, int len) {
  char* buf = allocateChunk(len + 8);
  int offset = 0;
  serializeHeader(buf, &offset, type, (unsigned short)len);
  sendRawBytes(sock, buf, offset + len);
  freeChunk(buf);
  return true;
}
void closeSession(int sock) {}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'session.cpp'), `
#include "packet.cpp"
#include "buffer.cpp"
#include "socket.cpp"

bool handleIncomingPacket(int sock, const char* raw, int len) {
  if (!validatePacketCrc(raw, len, true)) return false;
  int offset = 0;
  unsigned short type, plen;
  deserializeHeader(raw, &offset, &type, &plen, 2);
  return true;
}
bool queueOutgoingPacket(int sock, unsigned short type, const char* data, int len, unsigned char flags = 0) {
  char* buf = allocateChunk(len + 12);
  int offset = 0;
  serializeHeader(buf, &offset, type, (unsigned short)len, flags);
  sendRawBytes(sock, buf, offset + len);
  freeChunk(buf);
  return true;
}
void closeSession(int sock) {}
`);
        fs.writeFileSync(path.join(repo, 'packet.cpp'), `
void serializeHeader(char* outBuf, int* offset, unsigned short type, unsigned short len, unsigned char flags = 0) {
  memcpy(outBuf + *offset, &type, 2);
  *offset += 2;
  memcpy(outBuf + *offset, &len, 2);
  *offset += 2;
  outBuf[*offset] = flags;
  *offset += 1;
}
bool deserializeHeader(const char* inBuf, int* offset, unsigned short* type, unsigned short* len, int version = 1) {
  memcpy(type, inBuf + *offset, 2);
  *offset += 2;
  memcpy(len, inBuf + *offset, 2);
  *offset += 2;
  if (version >= 2) *offset += 1;
  return true;
}
bool validatePacketCrc(const char* buf, int bufLen, bool checkExtended = false) {
  if (bufLen < 4) return false;
  if (checkExtended && bufLen < 8) return false;
  return true;
}
void setPacketFlags(char* header, unsigned char flags) {}
`);
        fs.writeFileSync(path.join(repo, 'buffer.cpp'), `
char* allocateChunk(int size) { return (char*)malloc(size); }
void freeChunk(char* ptr) { free(ptr); }
void writeUint32(char* buf, int* offset, unsigned int val, bool bigEndian = false) {
  memcpy(buf + *offset, &val, 4);
  *offset += 4;
}
unsigned int readUint32(const char* buf, int* offset) {
  unsigned int val;
  memcpy(&val, buf + *offset, 4);
  *offset += 4;
  return val;
}
`);
        fs.writeFileSync(path.join(repo, 'pool.cpp'), `
char* acquireBuffer(int minSize, bool zeroInit = false) {
  char* p = allocateChunk(minSize);
  if (zeroInit && p) memset(p, 0, minSize);
  return p;
}
void releaseBuffer(char* buf) { freeChunk(buf); }
int getPoolCapacity() { return 64; }
void shrinkPool() {}
`);
        fs.writeFileSync(path.join(repo, 'crypto.cpp'), `
unsigned int computePacketChecksum(const char* data, int len, unsigned int seed = 0) {
  unsigned int sum = seed;
  for (int i = 0; i < len; i++) sum = (sum * 31) + (unsigned char)data[i];
  return sum;
}
void xorMaskPayload(char* payload, int len, unsigned char key) {}
bool verifySessionHmac(const char* sig, int len) { return len == 32; }
`);
      },
      'validatePacketCrc'
    );

    // =========================================================================
    // 9. C++ Case 3: Audio DSP Mixer & Decibel Scale (Ripple)
    // =========================================================================
    await runRealisticCase(
      'C++-R3 (오디오 게인 스케일 변경)', 'C++', '파급',
      (repo) => {
        fs.writeFileSync(path.join(repo, 'dsp_math.cpp'), `
float dbToLinear(float db) {
  return powf(10.0f, db / 20.0f);
}
float linearToDb(float lin) {
  return lin > 0.00001f ? 20.0f * log10f(lin) : -100.0f;
}
float clampSample(float s) {
  if (s > 1.0f) return 1.0f;
  if (s < -1.0f) return -1.0f;
  return s;
}
float softClipSample(float s) {
  return tanhf(s);
}
`);
        fs.writeFileSync(path.join(repo, 'filter.cpp'), `
void processBiquad(float* buffer, int frames) {}
void computeFilterCoeffs(float cutoff, float q) {}
void resetFilterState() {}
`);
        fs.writeFileSync(path.join(repo, 'voice.cpp'), `
#include "dsp_math.cpp"

void renderVoiceFrame(float* outBuffer, int frames, float gainDb) {
  float linGain = dbToLinear(gainDb);
  for (int i = 0; i < frames; i++) {
    outBuffer[i] *= linGain;
  }
}
void setVoicePitch(float pitch) {}
void setVoiceVolume(float vol) {}
bool isVoiceActive() { return true; }
`);
        fs.writeFileSync(path.join(repo, 'bus.cpp'), `
void mixAudioBuffers(float* dest, const float* src, int frames) {
  for (int i = 0; i < frames; i++) dest[i] += src[i];
}
void applyBusVolume(float* buffer, int frames, float volume) {
  for (int i = 0; i < frames; i++) buffer[i] *= volume;
}
void clearBusBuffer(float* buffer, int frames) {
  memset(buffer, 0, frames * sizeof(float));
}
`);
        fs.writeFileSync(path.join(repo, 'limiter.cpp'), `
void processLimiterFrame(float* buffer, int frames, float threshold) {
  for (int i = 0; i < frames; i++) {
    if (buffer[i] > threshold) buffer[i] = threshold;
  }
}
void updateEnvelopePeak(float current) {}
void releaseEnvelope() {}
`);
        fs.writeFileSync(path.join(repo, 'mixer.cpp'), `
#include "bus.cpp"
#include "limiter.cpp"
#include "voice.cpp"

void renderMainOutput(float* masterOut, int frames) {
  clearBusBuffer(masterOut, frames);
  renderVoiceFrame(masterOut, frames, -3.0f);
  processLimiterFrame(masterOut, frames, 0.95f);
}
void routeVoiceToBus(int voiceId, int busId) {}
void configureSampleRate(int sampleRate) {}
`);
      },
      (repo) => {
        fs.writeFileSync(path.join(repo, 'mixer.cpp'), `
#include "bus.cpp"
#include "limiter.cpp"
#include "voice.cpp"

void renderMainOutput(float* masterOut, int frames, bool enableLimiter = true) {
  clearBusBuffer(masterOut, frames);
  renderVoiceFrame(masterOut, frames, -3.0f);
  if (enableLimiter) {
    processLimiterFrame(masterOut, frames, 0.95f, 0.1f);
  }
}
void routeVoiceToBus(int voiceId, int busId) {}
void configureSampleRate(int sampleRate, int bufferBlockSize = 512) {}
`);
        fs.writeFileSync(path.join(repo, 'dsp_math.cpp'), `
float dbToLinear(float db) {
  return powf(10.0f, db / 10.0f);
}
float linearToDb(float lin) {
  return lin > 0.00001f ? 20.0f * log10f(lin) : -100.0f;
}
float clampSample(float s) {
  if (s > 1.0f) return 1.0f;
  if (s < -1.0f) return -1.0f;
  return s;
}
float softClipSample(float s) {
  return tanhf(s);
}
`);
        fs.writeFileSync(path.join(repo, 'bus.cpp'), `
void mixAudioBuffers(float* dest, const float* src, int frames, float mixGain = 1.0f) {
  for (int i = 0; i < frames; i++) dest[i] += src[i] * mixGain;
}
void applyBusVolume(float* buffer, int frames, float volume, bool mute = false) {
  if (mute) return;
  for (int i = 0; i < frames; i++) buffer[i] *= volume;
}
void clearBusBuffer(float* buffer, int frames) {
  memset(buffer, 0, frames * sizeof(float));
}
`);
        fs.writeFileSync(path.join(repo, 'limiter.cpp'), `
void processLimiterFrame(float* buffer, int frames, float threshold, float knee = 0.0f) {
  for (int i = 0; i < frames; i++) {
    if (buffer[i] > threshold) buffer[i] = threshold;
  }
}
void updateEnvelopePeak(float current) {}
void releaseEnvelope() {}
`);
        fs.writeFileSync(path.join(repo, 'voice.cpp'), `
#include "dsp_math.cpp"

void renderVoiceFrame(float* outBuffer, int frames, float gainDb) {
  float linGain = dbToLinear(gainDb);
  for (int i = 0; i < frames; i++) {
    outBuffer[i] *= linGain;
  }
}
void setVoicePitch(float pitch) {}
void setVoiceVolume(float vol, bool immediate = false) {}
bool isVoiceActive() { return true; }
`);
      },
      ['dbToLinear', 'renderVoiceFrame']
    );

    console.log('\n=================== 9 Realistic Benchmark Results (범위 좁히기) ===================');
    console.table(
      results.map((r) => ({
        예제: r.name,
        '저장소 전체 함수 수': r.totalRepoFunctions,
        '범위 함수 수 (changed / neighbor)': `${r.scopeCount} (${r.changedCount} / ${r.neighborCount})`,
        '정답이 범위 안에 있는가': r.inScope ? 'O' : 'X',
        '정답 위치': r.location,
        '범위 축소 비율': `${(r.reductionRatio * 100).toFixed(1)}%`,
      }))
    );

    const inScopeCount = results.filter((r) => r.inScope).length;
    const inScopePercent = ((inScopeCount / results.length) * 100).toFixed(1);
    const avgReduction = ((results.reduce((a, b) => a + b.reductionRatio, 0) / results.length) * 100).toFixed(1);

    console.log(`정답 포함 비율: ${inScopeCount}/${results.length} (${inScopePercent}%)`);
    console.log(`평균 범위 축소 비율: ${avgReduction}%`);

    for (const r of results) {
      assert.ok(r.inScope, `${r.name}: 정답 함수가 범위(changed 또는 neighbor) 안에 있어야 함`);
    }
  });

  test('Edge case 1: Untracked new file is discovered and localized', async () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'existing.py'), 'def old_func():\n    return 1\n');
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      // Create untracked new file
      fs.writeFileSync(
        path.join(repo, 'new_module.py'),
        'def brand_new_feature():\n    val = 42\n    return val * 2\n'
      );

      const res = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(res.totalChangedFiles, 1);
      assert.equal(res.changedFunctions.length, 1);
      assert.equal(res.changedFunctions[0].name, 'brand_new_feature');
      assert.equal(res.changedFunctions[0].filePath, 'new_module.py');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('Edge case 2: Fallback to NO_CHECKPOINT_HEAD when baseline is unavailable', async () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'test.py'), 'def foo():\n    return 1\n');
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      fs.writeFileSync(path.join(repo, 'test.py'), 'def foo():\n    return 2\n');

      const res = await locateChangeScope({ gitEngine }, { repoPath: repo });
      assert.equal(res.baselineSha, 'HEAD');
      assert.equal(res.baselineRule, 'NO_CHECKPOINT_HEAD');
      assert.ok(res.warnings.some((w) => w.includes('기준 시점 없음')));
      assert.equal(res.changedFunctions[0].name, 'foo');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('Edge case 3: Unsupported language produces HUNK candidate (+-15 lines)', async () => {
    const repo = createTempGitRepo();
    try {
      const initialRuby: string[] = [];
      for (let i = 1; i <= 40; i++) initialRuby.push(`puts "line ${i}"`);
      fs.writeFileSync(path.join(repo, 'script.rb'), initialRuby.join('\n'));
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      // Modify lines 20-22
      initialRuby[19] = 'puts "modified line 20"';
      initialRuby[20] = 'puts "modified line 21"';
      fs.writeFileSync(path.join(repo, 'script.rb'), initialRuby.join('\n'));

      const res = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(res.hunks.length, 1);
      const cand = res.hunks[0];
      assert.equal(cand.kind, 'HUNK');
      assert.ok(cand.name.includes('변경 덩어리'));
      assert.ok(cand.startLine <= 20);
      assert.ok(cand.endLine >= 21);
      assert.ok(cand.reasons.some((r) => r.includes('미지원 언어(.rb)')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('Edge case 4: Over 50 changed files triggers warning and top 50 truncation', async () => {
    const repo = createTempGitRepo();
    try {
      for (let i = 1; i <= 55; i++) {
        fs.writeFileSync(path.join(repo, `file_${i}.py`), `def func_${i}():\n    return ${i}\n`);
      }
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      // Modify all 55 files
      for (let i = 1; i <= 55; i++) {
        fs.writeFileSync(path.join(repo, `file_${i}.py`), `def func_${i}():\n    return ${i * 10}\n`);
      }

      const res = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(res.totalChangedFiles, 55);
      assert.equal(res.analyzedFiles, 50);
      assert.ok(res.warnings.some((w) => w.includes('50개를 초과하여 (55개)')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('Edge case 5: Baseline resolution via Rule 1 & Rule 2, and causeVerdict remains UNKNOWN', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_env_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const repo = createTempGitRepo();
    let core: CoreManager | undefined;
    try {
      fs.writeFileSync(path.join(repo, 'app.py'), 'def calculate(x):\n    return x + 1\n');
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      core = new CoreManager();
      core.ensureProject(repo);

      // 1. Create incident 1 BEFORE any checkpoint exists -> inc1.baseCheckpointId is null
      const inc1 = await core.collectIncidentBundle(repo, {
        title: 'Calculation error 1',
        agentName: 'antigravity',
        expectedBehavior: 'add 1',
        observedBehavior: 'multiplied by 10',
        reproductionCondition: 'run calculate',
        verificationMethod: 'test',
        userConfirmedIntent: true,
      });
      assert.equal(inc1.baseCheckpointId, null);
      assert.equal(inc1.causeVerdict, 'UNKNOWN');

      // Now create a clean checkpoint
      const cp1 = core.captureCheckpoint(repo, 'clean-baseline');

      // Now introduce modification in app.py
      fs.writeFileSync(path.join(repo, 'app.py'), 'def calculate(x):\n    return x * 10\n');

      const locCtx = {
        gitEngine,
        db: core.getDatabase(),
        ensureProject: (r: string) => core!.ensureProject(r),
      };

      // locateChangeScope for inc1: Rule 2 (LAST_GOOD_CHECKPOINT) triggers
      const resRule2 = await locateChangeScope(locCtx, { incidentId: inc1.id });
      assert.equal(resRule2.baselineRule, 'LAST_GOOD_CHECKPOINT');
      assert.equal(resRule2.baselineSha, cp1.worktreeCommitSha || cp1.gitHeadSha);
      assert.equal(resRule2.changedFunctions[0].name, 'calculate');

      // Verify incident causeVerdict is NOT escalated to CONFIRMED
      const fetchedInc1 = core.getDatabase().getIncident(inc1.id);
      assert.ok(fetchedInc1);
      assert.equal(fetchedInc1.causeVerdict, 'UNKNOWN', 'causeVerdict must remain UNKNOWN without execution evidence');
      assert.notEqual(fetchedInc1.causeVerdict, 'CONFIRMED', 'B-1 must never escalate causeVerdict to CONFIRMED');

      // 2. Create incident 2 AFTER checkpoint exists -> inc2.baseCheckpointId is cp1.id
      const inc2 = await core.collectIncidentBundle(repo, {
        title: 'Calculation error 2',
        agentName: 'antigravity',
        expectedBehavior: 'add 1',
        observedBehavior: 'multiplied by 10',
        reproductionCondition: 'run calculate',
        verificationMethod: 'test',
        userConfirmedIntent: true,
      });
      assert.equal(inc2.baseCheckpointId, cp1.id);

      // locateChangeScope for inc2: Rule 1 (INCIDENT_BASE_CHECKPOINT) triggers
      const resRule1 = await locateChangeScope(locCtx, { incidentId: inc2.id });
      assert.equal(resRule1.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
      assert.equal(resRule1.baselineSha, cp1.worktreeCommitSha || cp1.gitHeadSha);
      assert.equal(resRule1.changedFunctions[0].name, 'calculate');

      // Verify incident 2 causeVerdict is also UNKNOWN
      const fetchedInc2 = core.getDatabase().getIncident(inc2.id);
      assert.ok(fetchedInc2);
      assert.equal(fetchedInc2.causeVerdict, 'UNKNOWN');
      assert.notEqual(fetchedInc2.causeVerdict, 'CONFIRMED');
    } finally {
      if (core) {
        await core.shutdown();
      }
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });
});

describe('B-1c: AI Delivery Package (context-packer)', () => {
  const gitEngine = new GitEngine();

  test('Language-specific comment markers for Python, TS, and C++ with separate lines', async () => {
    const repo = createTempGitRepo();
    try {
      // 1. Python file with deletion trace
      fs.writeFileSync(
        path.join(repo, 'calc.py'),
        'def add(a, b):\n    unused_flag = 1\n    return a + b\n'
      );
      // 2. TypeScript file with addition
      fs.writeFileSync(
        path.join(repo, 'math.ts'),
        'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
      );
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      // Modify calc.py (pure deletion of unused_flag)
      fs.writeFileSync(
        path.join(repo, 'calc.py'),
        'def add(a, b):\n    return a + b\n'
      );
      // Modify math.ts (modify return)
      fs.writeFileSync(
        path.join(repo, 'math.ts'),
        'export function multiply(a: number, b: number): number {\n  return a * b * 2;\n}\n'
      );

      const scopeResult = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      const pkg = packChangeScopeFromScope(null, scopeResult, repo);

      // Verify Python markers: # >>> AUTOPSY
      assert.ok(pkg.packageText.includes('# >>> AUTOPSY 이 위치에서 줄 삭제됨'));

      // Verify TypeScript markers: // >>> AUTOPSY
      assert.ok(pkg.packageText.includes('// >>> AUTOPSY 변경된 줄'));

      // Verify markers are separate lines before code lines, no diff "+ " prefix
      assert.ok(!pkg.packageText.includes('+  return a * b * 2;'));
      assert.ok(pkg.packageText.includes('    return a + b'));
      assert.ok(pkg.packageText.includes('  return a * b * 2;'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('3-Step progressive truncation preserves all function names and locations even when budget exceeded', async () => {
    const repo = createTempGitRepo();
    try {
      // Create 3 large functions in Python (>120 lines each)
      const linesF1: string[] = ['def big_func_1():'];
      for (let i = 1; i <= 120; i++) linesF1.push(`    val_${i} = ${i}`);
      linesF1.push('    return val_120');

      const linesF2: string[] = ['def big_func_2():'];
      for (let i = 1; i <= 120; i++) linesF2.push(`    item_${i} = ${i}`);
      linesF2.push('    return item_120');

      const linesF3: string[] = ['def big_func_3():'];
      for (let i = 1; i <= 120; i++) linesF3.push(`    data_${i} = ${i}`);
      linesF3.push('    return data_120');

      fs.writeFileSync(path.join(repo, 'big.py'), [linesF1.join('\n'), linesF2.join('\n'), linesF3.join('\n')].join('\n\n'));
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      // Modify line 50 in each function
      linesF1[50] = '    val_50 = 99999';
      linesF2[50] = '    item_50 = 88888';
      linesF3[50] = '    data_50 = 77777';
      fs.writeFileSync(path.join(repo, 'big.py'), [linesF1.join('\n'), linesF2.join('\n'), linesF3.join('\n')].join('\n\n'));

      const scopeResult = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(scopeResult.changedFunctions.length, 3);

      // Step 1 check (>100 lines reduced to +-15 lines with restricted budget)
      const pkgStep1 = packChangeScopeFromScope(null, scopeResult, repo, { maxCharacters: 4000 });
      assert.ok(pkgStep1.truncationStep >= 1);
      assert.ok(pkgStep1.packageText.includes('# ... (생략) ...'));
      assert.ok(pkgStep1.packageText.includes('big_func_1'));
      assert.ok(pkgStep1.packageText.includes('big_func_2'));
      assert.ok(pkgStep1.packageText.includes('big_func_3'));

      // Step 2 check (tight budget 2000 chars -> signature + +-5 lines)
      const pkgStep2 = packChangeScopeFromScope(null, scopeResult, repo, { maxCharacters: 2000 });
      assert.ok(pkgStep2.truncationStep >= 2);
      assert.ok(pkgStep2.packageText.includes('big_func_1'));
      assert.ok(pkgStep2.packageText.includes('big_func_2'));
      assert.ok(pkgStep2.packageText.includes('big_func_3'));

      // Step 3 check (extreme budget 900 chars -> bodies stripped, but all names and locations preserved!)
      const pkgStep3 = packChangeScopeFromScope(null, scopeResult, repo, { maxCharacters: 900 });
      assert.equal(pkgStep3.truncationStep, 3);
      assert.ok(pkgStep3.packageText.includes('big_func_1'));
      assert.ok(pkgStep3.packageText.includes('big_func_2'));
      assert.ok(pkgStep3.packageText.includes('big_func_3'));
      assert.ok(pkgStep3.packageText.includes('본문 생략됨'));
      assert.ok(pkgStep3.packageText.includes('big.py:'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('Package text notice and absence of ranking or confirmed cause expressions', async () => {
    const repo = createTempGitRepo();
    try {
      fs.writeFileSync(path.join(repo, 'app.py'), 'def calculate(x):\n    return x + 1\n');
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });
      fs.writeFileSync(path.join(repo, 'app.py'), 'def calculate(x):\n    return x + 2\n');

      const scopeResult = await locateChangeScope({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      const pkg = packChangeScopeFromScope(null, scopeResult, repo);

      // 1. Mandatory Notice text check
      assert.ok(pkg.packageText.includes('아래는 기준 시점 이후 바뀐 함수와 그 호출 관계에 있는 함수다.'));
      assert.ok(pkg.packageText.includes('순위가 아니며, 실행 증거로 확인된 원인도 아니다.'));
      assert.ok(pkg.packageText.includes('큰 변경이 버그라는 뜻이 아니다. 계산식, 비교 연산자, 빠진 필드처럼 작은 변경도 확인하라.'));

      // 2. Forbidden ranking and verdict expressions check
      assert.ok(!pkg.packageText.includes('1위'));
      assert.ok(!pkg.packageText.includes('1순위'));
      assert.ok(!pkg.packageText.includes('원인 확정'));
      assert.ok(!pkg.packageText.includes('CONFIRMED'));
      assert.ok(!pkg.packageText.includes('점수'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('CoreManager getChangeScope integration with incident intents and provenance', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_packer_env_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const repo = createTempGitRepo();
    let core: CoreManager | undefined;
    try {
      fs.writeFileSync(path.join(repo, 'service.py'), 'def process_order(price):\n    return price * 1.0\n');
      execSync('git add . && git commit -m "initial"', { cwd: repo, stdio: 'ignore' });

      core = new CoreManager();
      core.ensureProject(repo);

      const cp = core.captureCheckpoint(repo, 'clean-baseline');

      fs.writeFileSync(path.join(repo, 'service.py'), 'def process_order(price):\n    return price * 0.5\n');

      const inc = await core.collectIncidentBundle(repo, {
        title: 'Discount logic incorrect',
        userReportText: '원래는 정상 정가 청구가 되어야 하는데 실제 주문 시 가격이 절반으로 깎여서 주문됩니다.',
        agentName: 'antigravity',
        expectedBehavior: '정상 정가 청구',
        observedBehavior: '가격이 절반으로 깎여서 주문',
        reproductionCondition: 'process_order 호출',
        verificationMethod: '단위 테스트 확인',
        userConfirmedIntent: true,
      });

      const res = await core.getChangeScope(inc.id);
      assert.ok(res.packageText.length > 0);
      assert.ok(res.packageText.includes('가격이 절반으로 깎여서 주문됩니다.'));
      assert.ok(res.packageText.includes('기대 동작 [USER_QUOTE]: 정상 정가 청구'));
      assert.ok(res.packageText.includes('실제 증상 [USER_QUOTE]: 가격이 절반으로 깎여서 주문'));
      assert.ok(res.packageText.includes('재현 조건 [AI_INFERRED]: process_order 호출'));
      assert.equal(res.scopeResult.changedFunctions.length, 1);
      assert.equal(res.scopeResult.changedFunctions[0].name, 'process_order');
      assert.ok(res.characterCount > 0);
      assert.equal(res.truncationStep, 0);
    } finally {
      if (core) await core.shutdown();
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });
});

describe('B-1d: Incident Flow Integration with Change Scope', () => {
  test('1. Incident collection response contains change_scope_summary with exact function name and line ranges', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_flow_env_1_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const repo = createTempGitRepo();
    let core: CoreManager | undefined;
    try {
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src', 'billing.js'),
        'function calculateDiscount(user, amount) {\n  return 0;\n}\n\nmodule.exports = { calculateDiscount };\n'
      );
      execSync('git add . && git commit -m "initial commit"', { cwd: repo, stdio: 'ignore' });

      core = new CoreManager();
      core.ensureProject(repo);

      // Modify the function
      fs.writeFileSync(
        path.join(repo, 'src', 'billing.js'),
        'function calculateDiscount(user, amount) {\n  return amount * 0.1;\n}\n\nmodule.exports = { calculateDiscount };\n'
      );

      const inc = await core.collectIncidentBundle(repo, {
        title: 'Discount rate calculation error',
        userReportText: '할인율 계산 시 calculateDiscount 함수에서 10% 할인이 제대로 적용되지 않습니다.',
        agentName: 'antigravity',
        expectedBehavior: 'amount * 0.1 할인 반환',
        observedBehavior: '0 반환',
        reproductionCondition: 'calculateDiscount(user, 1000) 호출',
        verificationMethod: '결과값 검증',
        userConfirmedIntent: true,
      });

      assert.ok(inc.change_scope_summary, 'change_scope_summary must exist on incident');
      assert.ok(inc.changeScopeSummary, 'changeScopeSummary must exist on incident');
      assert.strictEqual(typeof inc.change_scope_summary, 'object');

      const summary = inc.change_scope_summary as any;
      assert.ok(summary.baselineSha, 'baselineSha must exist');
      assert.ok(summary.baselineRule, 'baselineRule must exist');
      assert.ok(Array.isArray(summary.warnings), 'warnings must be an array');
      assert.ok(summary.scopeStats, 'scopeStats must exist');

      assert.strictEqual(summary.changedFunctions.length, 1);
      const fn = summary.changedFunctions[0];
      assert.strictEqual(fn.name, 'calculateDiscount');
      assert.strictEqual(fn.filePath, 'src/billing.js');
      assert.strictEqual(fn.startLine, 1);
      assert.strictEqual(fn.endLine, 3);
    } finally {
      if (core) await core.shutdown();
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });

  test('2. Failure handling on non-git folder succeeds and leaves warning string in change_scope_summary', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_flow_env_2_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_nongit_dir_'));
    let core: CoreManager | undefined;
    try {
      fs.writeFileSync(path.join(nonGitDir, 'script.js'), 'console.log("hello");\n');

      core = new CoreManager();
      const inc = await core.collectIncidentBundle(nonGitDir, {
        title: 'Non-git project test',
        userReportText: 'git이 아닌 폴더에서 사건 번들 수집 테스트',
        agentName: 'antigravity',
      });

      // Incident registration MUST succeed
      assert.ok(inc.id, 'Incident ID must be generated');
      assert.strictEqual(inc.title, 'Non-git project test');
      assert.strictEqual(inc.status, 'OPEN');

      // change_scope_summary must contain warning string
      assert.ok(inc.change_scope_summary, 'change_scope_summary must exist');
      assert.strictEqual(typeof inc.change_scope_summary, 'string', 'change_scope_summary should be a warning string');
      const warningText = inc.change_scope_summary as string;
      assert.ok(
        warningText.includes('경고') || warningText.includes('실패'),
        'Warning string should indicate failure'
      );
    } finally {
      if (core) await core.shutdown();
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(nonGitDir, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });

  test('3. 30-cap limit on changed functions triggers truncation notice', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_flow_env_3_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const repo = createTempGitRepo();
    let core: CoreManager | undefined;
    try {
      // Create 35 functions
      const funcs: string[] = [];
      for (let i = 1; i <= 35; i++) {
        funcs.push(`function func_${i}() {\n  return 0;\n}\n`);
      }
      fs.writeFileSync(path.join(repo, 'many.js'), funcs.join('\n'));
      execSync('git add . && git commit -m "35 functions baseline"', { cwd: repo, stdio: 'ignore' });

      core = new CoreManager();
      core.ensureProject(repo);

      // Modify all 35 functions
      const modified: string[] = [];
      for (let i = 1; i <= 35; i++) {
        modified.push(`function func_${i}() {\n  return ${i};\n}\n`);
      }
      fs.writeFileSync(path.join(repo, 'many.js'), modified.join('\n'));

      const inc = await core.collectIncidentBundle(repo, {
        title: '35 functions changed',
        userReportText: '35개 함수가 동시에 변경되었습니다.',
        agentName: 'antigravity',
      });

      assert.ok(inc.change_scope_summary && typeof inc.change_scope_summary === 'object');
      const summary = inc.change_scope_summary as any;

      // Exactly 30 functions in changedFunctions
      assert.strictEqual(summary.changedFunctions.length, 30, 'Must cap at 30 functions');

      // Notice for remaining 5
      const expectedNotice = '나머지 5개는 get_change_scope로 확인';
      assert.strictEqual(summary.notice, expectedNotice, 'notice must state remaining 5 functions');
      assert.ok(
        summary.warnings.some((w: string) => w.includes(expectedNotice)),
        'warnings must include remaining notice'
      );
    } finally {
      if (core) await core.shutdown();
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });

  test('4. next_action retains action RUN_REPRODUCTION_OR_PROPOSE_REPAIR and agent_should guides get_change_scope', async () => {
    const tempEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy_flow_env_4_'));
    const oldData = process.env.AUTOPSY_DATA_DIR;
    const oldCache = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = path.join(tempEnv, 'data');
    process.env.AUTOPSY_CACHE_DIR = path.join(tempEnv, 'cache');

    const repo = createTempGitRepo();
    let core: CoreManager | undefined;
    try {
      fs.writeFileSync(path.join(repo, 'calc.js'), 'function calc() { return 1; }\n');
      execSync('git add . && git commit -m "init"', { cwd: repo, stdio: 'ignore' });

      core = new CoreManager();
      const inc = await core.collectIncidentBundle(repo, {
        title: 'Calculation error',
        userReportText: '기대 동작: 정상 합산, 실제 결과: 0 반환, 재현: calc() 호출, 검증: 단위 테스트',
        agentName: 'antigravity',
        expectedBehavior: '정상 합산',
        observedBehavior: '0 반환',
        reproductionCondition: 'calc() 호출',
        verificationMethod: '단위 테스트',
        userConfirmedIntent: true,
      });

      const nextAction = core.getIncidentNextAction(inc);
      assert.strictEqual(nextAction.actor, 'AGENT');
      assert.strictEqual(nextAction.action, 'RUN_REPRODUCTION_OR_PROPOSE_REPAIR');
      assert.ok(nextAction.agent_should.includes('get_change_scope'));
      assert.ok(nextAction.agent_should.includes('기준 시점 이후 바뀐 함수의 코드'));
      assert.ok(nextAction.agent_should.includes('저장소 전체를 처음부터 읽지 마세요'));
      // No ranking or confirmed cause expressions
      assert.ok(!nextAction.agent_should.includes('1위'));
      assert.ok(!nextAction.agent_should.includes('순위'));
      assert.ok(!nextAction.agent_should.includes('확정 원인'));
    } finally {
      if (core) await core.shutdown();
      if (oldData) process.env.AUTOPSY_DATA_DIR = oldData;
      else delete process.env.AUTOPSY_DATA_DIR;
      if (oldCache) process.env.AUTOPSY_CACHE_DIR = oldCache;
      else delete process.env.AUTOPSY_CACHE_DIR;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(tempEnv, { recursive: true, force: true });
    }
  });

  test('5. AGENTS.md and getAgentsMdTemplate() get_change_scope guidance phrasing match strictly', () => {
    let cur = path.dirname(fileURLToPath(import.meta.url));
    let agentsMdPath = '';
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(cur, 'AGENTS.md');
      if (fs.existsSync(candidate)) {
        agentsMdPath = candidate;
        break;
      }
      cur = path.dirname(cur);
    }
    assert.ok(agentsMdPath, 'AGENTS.md path must be found');
    const agentsMdContent = fs.readFileSync(agentsMdPath, 'utf8').trim();
    const templateContent = getAgentsMdTemplate().trim();

    const requiredPhrase = '사건 등록 후 바뀐 함수 범위를 `get_change_scope`로 먼저 확인하라. 이 범위는 순위가 아니고 원인 확정도 아니다.';
    assert.ok(
      agentsMdContent.includes(requiredPhrase) ||
        (agentsMdContent.includes('사건 등록 후 바뀐 함수 범위를') &&
          agentsMdContent.includes('get_change_scope') &&
          agentsMdContent.includes('이 범위는 순위가 아니고 원인 확정도 아니다.')),
      'AGENTS.md must contain the required phrase'
    );
    assert.ok(
      templateContent.includes(requiredPhrase) ||
        (templateContent.includes('사건 등록 후 바뀐 함수 범위를') &&
          templateContent.includes('get_change_scope') &&
          templateContent.includes('이 범위는 순위가 아니고 원인 확정도 아니다.')),
      'getAgentsMdTemplate() must contain the required phrase'
    );
    assert.strictEqual(templateContent, agentsMdContent, 'getAgentsMdTemplate() must strictly match AGENTS.md');
  });
});

