module.exports = {
  number(value, defaultValue, { base = 10 } = {}) {
    if (typeof value === "number") {
      // Ironically typeof NaN === "number". WTF JavaScript? ¯\_(ツ)_/¯
      return Number.isNaN(value) ? defaultValue : value;
    }

    const parsedValue = Number.parseInt(value, base);
    return Number.isNaN(parsedValue) ? defaultValue : parsedValue;
  },
  boolean(value, defaultValue) {
    if (typeof value === "boolean") {
      return value;
    }

    let parsedValue;
    try {
      parsedValue = JSON.parse(parsedValue);
    } catch (err) {
      parsedValue = defaultValue;
    }

    return Boolean(parsedValue);
  },
};
