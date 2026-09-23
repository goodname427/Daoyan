export const PRODUCT_INTENT_ARTIFACT = 'intent-alignment.json';

export interface ProductIntentAlignment {
  schemaVersion: 1;
  versionId: string;
  charterRevision: string;
  producerSignals: string[];
  inferredPrinciple: string;
  adjacentCases: { scenario: string; expectedBehavior: string }[];
  recommendedExperience: string;
  scopeBoundary: string;
  openAssumptions: string[];
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('产品意图对齐缺少' + label);
  }
  if (value.trim().length > 300) {
    throw new Error('产品意图对齐的' + label + '过长，请把详细论证放在策划案中');
  }
  return value.trim();
}

function textList(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error('产品意图对齐的' + label + '数量无效');
  }
  return value.map((entry) => nonEmptyText(entry, label));
}

export function parseProductIntentAlignment(
  value: unknown,
  versionId: string,
  charterRevision: string,
): ProductIntentAlignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('版本策划缺少结构化产品意图对齐记录');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('产品意图对齐记录版本无效');
  if (record.versionId !== versionId || record.charterRevision !== charterRevision) {
    throw new Error('产品意图对齐记录与当前版本或策划修订不匹配');
  }
  const adjacentCases = record.adjacentCases;
  if (!Array.isArray(adjacentCases) || adjacentCases.length < 2 || adjacentCases.length > 4) {
    throw new Error('产品意图对齐至少需要两个未被制作人逐项指定的相邻情形');
  }
  const parsedCases = adjacentCases.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('产品意图对齐的相邻情形格式无效');
    }
    const item = entry as Record<string, unknown>;
    return {
      scenario: nonEmptyText(item.scenario, '相邻情形'),
      expectedBehavior: nonEmptyText(item.expectedBehavior, '相邻情形的预期行为'),
    };
  });
  if (new Set(parsedCases.map((entry) => entry.scenario)).size !== parsedCases.length) {
    throw new Error('产品意图对齐的相邻情形不能重复');
  }
  return {
    schemaVersion: 1,
    versionId,
    charterRevision,
    producerSignals: textList(record.producerSignals, '制作人原始信号', 1, 8),
    inferredPrinciple: nonEmptyText(record.inferredPrinciple, '推断的系统原则'),
    adjacentCases: parsedCases,
    recommendedExperience: nonEmptyText(record.recommendedExperience, '补全后的推荐体验'),
    scopeBoundary: nonEmptyText(record.scopeBoundary, '原则适用边界'),
    openAssumptions: textList(record.openAssumptions, '待确认假设', 0, 5),
  };
}

export function productIntentReviewSummary(alignment: ProductIntentAlignment): string {
  const nearby = alignment.adjacentCases
    .slice(0, 2)
    .map((entry) => entry.scenario + '→' + entry.expectedBehavior)
    .join('；');
  const uncertainty = alignment.openAssumptions.length
    ? '待确认：' + alignment.openAssumptions.join('；') + '。'
    : '没有另外标记的待确认假设。';
  return (
    '策划推断的核心原则：' +
    alignment.inferredPrinciple +
    '。相邻情形：' +
    nearby +
    '。建议玩家体验：' +
    alignment.recommendedExperience +
    '。适用边界：' +
    alignment.scopeBoundary +
    '。' +
    uncertainty
  );
}
