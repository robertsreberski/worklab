export function codexModelSupportsFastMode(model) {
  return String(model || "").trim().toLowerCase().startsWith("gpt-");
}

export function normalizeFastMode(value, fallback = true) {
  if (value === undefined || value === null || value === "") return !!fallback;
  return value === true || value === 1;
}
