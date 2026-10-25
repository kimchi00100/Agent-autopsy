import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { extractFunctions } from '../src/localization/function-extractor.js';
import { locateCandidates } from '../src/localization/change-localizer.js';
import { GitEngine } from '../src/git/git-engine.js';
import { CoreManager } from '../src/core-manager.js';

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

  test('12 Benchmark cases across Python, TypeScript, and C++ (4 bug types)', async () => {
    interface BenchmarkResult {
      name: string;
      lang: string;
      type: string;
      expected: string;
      top1Candidate: string;
      isTop1: boolean;
      isTop5: boolean;
    }

    const results: BenchmarkResult[] = [];

    async function runCase(
      name: string,
      lang: string,
      type: string,
      setupFn: (repo: string) => void,
      modifyFn: (repo: string) => void,
      expectedGroundTruth: string | string[],
      isRipple = false,
      rippleUnchangedName = ''
    ): Promise<void> {
      const repo = createTempGitRepo();
      try {
        setupFn(repo);
        execSync('git add . && git commit -m "baseline"', { cwd: repo, stdio: 'ignore' });
        modifyFn(repo);
        const res = await locateCandidates({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });

        const top1 = res.candidates[0]?.name || '';
        const top5Names = res.candidates.map((c) => c.name);

        let isTop1 = false;
        let isTop5 = false;

        if (Array.isArray(expectedGroundTruth)) {
          isTop1 = expectedGroundTruth.includes(top1);
          isTop5 = expectedGroundTruth.some((gt) => top5Names.includes(gt));
        } else {
          isTop1 = top1 === expectedGroundTruth;
          isTop5 = top5Names.includes(expectedGroundTruth);
        }

        if (isRipple && rippleUnchangedName) {
          const bCand = res.candidates.find((c) => c.name === rippleUnchangedName);
          assert.ok(bCand, `Ripple unchanged function ${rippleUnchangedName} must be in candidates`);
          assert.ok(bCand.rank <= 5, `Ripple unchanged function ${rippleUnchangedName} must be in top 5`);
          assert.equal(bCand.isNeighbor, true, 'Must be marked isNeighbor');
        }

        results.push({
          name,
          lang,
          type,
          expected: Array.isArray(expectedGroundTruth) ? expectedGroundTruth.join('/') : expectedGroundTruth,
          top1Candidate: top1,
          isTop1,
          isTop5,
        });

        assert.ok(isTop5, `${name}: Ground truth must be in top 5`);
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
      'calculate_tax'
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
      'handleRequest'
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
      'processJob'
    );

    console.log('\n=================== 12 Benchmark Results ===================');
    console.table(
      results.map((r) => ({
        예제: r.name,
        언어: r.lang,
        유형: r.type,
        '기대 정답': r.expected,
        '1위 후보': r.top1Candidate,
        'Top-1 일치': r.isTop1 ? 'O' : 'X',
        'Top-5 포함': r.isTop5 ? 'O' : 'X',
      }))
    );

    const top1Count = results.filter((r) => r.isTop1).length;
    const top5Count = results.filter((r) => r.isTop5).length;
    const top1Ratio = ((top1Count / results.length) * 100).toFixed(1);
    const top5Ratio = ((top5Count / results.length) * 100).toFixed(1);

    console.log(`총 예제: ${results.length}개`);
    console.log(`Top-1 성공률: ${top1Count}/${results.length} (${top1Ratio}%)`);
    console.log(`Top-5 성공률: ${top5Count}/${results.length} (${top5Ratio}%)`);
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

      const res = await locateCandidates({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(res.totalChangedFiles, 1);
      assert.equal(res.candidates.length, 1);
      assert.equal(res.candidates[0].name, 'brand_new_feature');
      assert.equal(res.candidates[0].filePath, 'new_module.py');
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

      const res = await locateCandidates({ gitEngine }, { repoPath: repo });
      assert.equal(res.baselineSha, 'HEAD');
      assert.equal(res.baselineRule, 'NO_CHECKPOINT_HEAD');
      assert.ok(res.warnings.some((w) => w.includes('기준 시점 없음')));
      assert.equal(res.candidates[0].name, 'foo');
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

      const res = await locateCandidates({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
      assert.equal(res.candidates.length, 1);
      const cand = res.candidates[0];
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

      const res = await locateCandidates({ gitEngine }, { repoPath: repo, baselineSha: 'HEAD' });
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

      // locateCandidates for inc1: Rule 2 (LAST_GOOD_CHECKPOINT) triggers
      const resRule2 = await locateCandidates(locCtx, { incidentId: inc1.id });
      assert.equal(resRule2.baselineRule, 'LAST_GOOD_CHECKPOINT');
      assert.equal(resRule2.baselineSha, cp1.worktreeCommitSha || cp1.gitHeadSha);
      assert.equal(resRule2.candidates[0].name, 'calculate');

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

      // locateCandidates for inc2: Rule 1 (INCIDENT_BASE_CHECKPOINT) triggers
      const resRule1 = await locateCandidates(locCtx, { incidentId: inc2.id });
      assert.equal(resRule1.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
      assert.equal(resRule1.baselineSha, cp1.worktreeCommitSha || cp1.gitHeadSha);
      assert.equal(resRule1.candidates[0].name, 'calculate');

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

