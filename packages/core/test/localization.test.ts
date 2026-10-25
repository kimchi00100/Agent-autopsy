import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractFunctions } from '../src/localization/function-extractor.js';

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
