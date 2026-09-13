# 当前实现参考

这些文档回答“现在怎样使用”，内容应与代码保持一致：

1. [`spell-authoring.md`](./spell-authoring.md)：从零编写、测试和排查法术。
2. [`meta-spells.md`](./meta-spells.md)：当前全部元法术，由注册代码自动生成。
3. [`entities-and-attributes.md`](./entities-and-attributes.md)：当前实体、弹道、属性和资源公式。

元法术实现变化后运行 `npm run docs:generate`，再运行 `npm run docs:check`。尚未采纳的设计不要写成当前事实，应放入 [`../proposals/`](../proposals/)。
