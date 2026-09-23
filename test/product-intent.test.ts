import { describe, expect, it } from 'vitest';
import { parseProductIntentAlignment, productIntentReviewSummary } from '../scripts/product-intent';

const valid = {
  schemaVersion: 1,
  versionId: 'version-1',
  charterRevision: '2',
  producerSignals: ['减速和破防只是统一控制能力的例子'],
  inferredPrinciple: '所有有权控制的属性遵循共同的效果、期限与资源合同',
  adjacentCases: [
    { scenario: '控制施法速度', expectedBehavior: '通过同一合同定价和结束' },
    { scenario: '控制法球运动上限', expectedBehavior: '按能力授权并结算' },
  ],
  recommendedExperience: '玩家能在推演和实战中组合并观察各种控制',
  scopeBoundary: '物理积分本身不作为玩家元法术',
  openAssumptions: ['是否向玩家开放全部属性'],
};

describe('product intent alignment', () => {
  it('preserves the principle and nearby cases for the producer review', () => {
    const alignment = parseProductIntentAlignment(valid, 'version-1', '2');
    expect(alignment.adjacentCases).toHaveLength(2);
    expect(productIntentReviewSummary(alignment)).toContain('所有有权控制的属性');
    expect(productIntentReviewSummary(alignment)).toContain('控制法球运动上限');
    expect(productIntentReviewSummary(alignment)).toContain('物理积分本身');
    expect(productIntentReviewSummary(alignment)).toContain('是否向玩家开放全部属性');
  });

  it('rejects a case-only plan or a stale charter revision', () => {
    expect(() =>
      parseProductIntentAlignment({ ...valid, adjacentCases: [] }, 'version-1', '2'),
    ).toThrow('至少需要两个');
    expect(() => parseProductIntentAlignment(valid, 'version-1', '3')).toThrow('修订不匹配');
    expect(() =>
      parseProductIntentAlignment({ ...valid, inferredPrinciple: '' }, 'version-1', '2'),
    ).toThrow('系统原则');
    expect(() =>
      parseProductIntentAlignment(
        { ...valid, inferredPrinciple: '重复原话'.repeat(100) },
        'version-1',
        '2',
      ),
    ).toThrow('过长');
  });
});
