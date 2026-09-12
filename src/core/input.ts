/**
 * 按键状态。法术通过元函数读取，实现「按住蓄力 / 松开释放」等机制。
 *
 * 关键设计：**按下/松开是粘性边沿** —— 发生一次后保持 true，
 * 直到法术通过「按键按下/按键松开」读取它才清除。
 * 这样 duration 法术的周期轮询不会漏掉松开瞬间。
 */
export interface KeyState {
  /** 当前是否按住 */
  held: boolean;
  /** 已按住秒数（松开后归零） */
  heldTime: number;
  /** 粘性按下边沿 */
  pressEdge: boolean;
  /** 粘性松开边沿 */
  releaseEdge: boolean;
}

export function makeKeyState(): KeyState {
  return { held: false, heldTime: 0, pressEdge: false, releaseEdge: false };
}
