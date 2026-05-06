/**
 * Formatea un objeto Date a string "YYYY-MM".
 * @param {Date} date
 * @returns {string}
 */
function formatYYYYMM(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function currentYYYYMM() {
  const override = process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(override || '')) return override;
  return formatYYYYMM(new Date());
}

/**
 * Devuelve el período siguiente dado uno en formato "YYYY-MM".
 * Maneja el cruce de año (ej: "2026-12" → "2027-01").
 * @param {string} yyyyMM
 * @returns {string}
 */
function getNextMonth(yyyyMM) {
  const [year, month] = yyyyMM.split('-').map(Number);
  // month es 1-based; new Date(year, month, 1) usa 0-based, por lo que
  // pasar `month` sin restar 1 equivale a sumar un mes.
  const d = new Date(year, month, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { formatYYYYMM, currentYYYYMM, getNextMonth };
