// Permite que JSON.stringify serialice BigInt automáticamente a string
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
