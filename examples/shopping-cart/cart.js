function calculateTotal(items, discountCode) {
  let total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (discountCode === 'WELCOME10') {
    // 버그: 10% 할인이 아니라 단순 10원 차감으로 잘못 작성됨
    total = total - 10;
  }

  return total;
}

module.exports = { calculateTotal };
