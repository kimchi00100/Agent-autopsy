const assert = require('assert');
const { calculateTotal } = require('./cart.js');

// 1. 일반 합계 테스트
const items = [{ price: 100, quantity: 2 }]; // 200원
assert.strictEqual(calculateTotal(items), 200);

// 2. 10% 환영 쿠폰 할인 테스트 (200원의 10% = 180원이어야 함)
const discounted = calculateTotal(items, 'WELCOME10');
assert.strictEqual(discounted, 180, `WELCOME10 쿠폰은 10% 할인이 적용되어 180원이어야 하지만 ${discounted}원이 반환되었습니다.`);

console.log('✔ 장바구니 결제 테스트 통과 (ALL TESTS PASSED)');
