export default {
  test: {
    environment: 'node',
    include: ['test/entity-vnext.test.ts'],
    pool: 'threads',
    fileParallelism: false,
  },
};
