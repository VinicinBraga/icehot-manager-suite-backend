const add = (a, b) => {
  return a + b;
};

const divide = (a, b) => {
  return a / b;
};

const calculate = (x, y, operation) => {
  return operation(x, y);
};

console.log(calculate(2, 2, add));

console.log(calculate(2, 2, divide));
