function validateInput(data, requiredFields) {
  const errors = [];

  for (const field of requiredFields) {
    const v = data[field];

    // IMPORTANT: do not treat 0/false as missing (we use index=0, closed=false, etc.)
    const isMissing =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.toString().trim() === "");

    if (isMissing) {
      errors.push(`Campo '${field}' é obrigatório`);
    }
  }

  return errors;
}

module.exports = { validateInput };
