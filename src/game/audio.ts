/**
 * 音频系统（WebAudio 程序化合成，无外部音频文件）。
 *
 * 与精灵图同理：先用程序化合成把「什么时候该响」的链路打通，
 * 后续要换真实音效时只需替换 play() 里各分支的实现。
 */

export type SfxKind = 'cast' | 'shoot' | 'hit' | 'hurt' | 'death' | 'backfire' | 'wave';

export class Sfx {
  enabled = true;
  volume = 0.4;

  private ctx: AudioContext | null = null;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** 首次用户交互后调用，解除浏览器自动播放限制 */
  unlock(): void {
    this.ensure();
  }

  private tone(
    freq: number,
    dur: number,
    opts: {
      type?: OscillatorType;
      gain?: number;
      slideTo?: number;
      delay?: number;
    } = {},
  ): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const { type = 'sine', gain = 0.2, slideTo, delay = 0 } = opts;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain * this.volume, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, gain = 0.15, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain * this.volume;
    src.connect(g).connect(ctx.destination);
    src.start(t0);
  }

  play(kind: SfxKind): void {
    switch (kind) {
      case 'cast':
        this.tone(240, 0.28, { type: 'sine', gain: 0.16, slideTo: 520 });
        break;
      case 'shoot':
        this.tone(920, 0.1, { type: 'square', gain: 0.1, slideTo: 260 });
        this.noise(0.05, 0.06);
        break;
      case 'hit':
        this.noise(0.07, 0.14);
        this.tone(180, 0.09, { type: 'triangle', gain: 0.14, slideTo: 90 });
        break;
      case 'hurt':
        this.tone(140, 0.22, { type: 'sawtooth', gain: 0.12, slideTo: 70 });
        break;
      case 'death':
        this.tone(300, 0.5, { type: 'sawtooth', gain: 0.16, slideTo: 46 });
        this.noise(0.2, 0.08, 0.05);
        break;
      case 'backfire':
        // 两个不和谐音叠加 —— 「走火入魔」听起来就该难受
        this.tone(196, 0.42, { type: 'sawtooth', gain: 0.12 });
        this.tone(208, 0.42, { type: 'sawtooth', gain: 0.12 });
        this.noise(0.3, 0.1);
        break;
      case 'wave':
        this.tone(330, 0.2, { type: 'sine', gain: 0.14 });
        this.tone(440, 0.24, { type: 'sine', gain: 0.14, delay: 0.16 });
        break;
    }
  }
}

export const sfx = new Sfx();
