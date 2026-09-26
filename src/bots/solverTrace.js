
/**
 * Structured decision trace and detailed explanation helper for solver and smart bot fallback/reasons.
 */
export function getDetailedSolverReason(res, action, value) {
  if (!res) return 'Решатель не применялся или недоступен.';
  if (res.timedOut) return 'Решатель превысил лимит узлов/времени (timedOut), выполнен откат на эвристику.';
  if (!res.solved || !res.action) return 'Решатель не смог гарантировать результат (unusable), выполнен откат на эвристику.';
  if (res.mismatch) return 'Обнаружено расхождение состояния с движком, откат на эвристику.';
  if (res.failed) return 'Ошибка восстановления позиции для решателя, откат на эвристику.';
  if (value < 0) return 'Позиция доказанно проиграна по точному расчету, используется защитная эвристика.';
  return `Точный расчет завершен: победа/ничья (value=${value}), ход обоснован решателем.`;
}
