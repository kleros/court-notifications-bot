function ensureEnv(key, msg = `process.env.${key} is not defined`) {
  const value = process.env[key];

  if (value === undefined || value === null || trimString(value) === "") {
    throw new Error(msg);
  }

  return value;
}

const trimString =
  typeof String.prototype.trim === "function"
    ? (str) => str.trim()
    : (str) => str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");

module.exports = {
  ensureEnv,
};
