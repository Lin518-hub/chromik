import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

/**
 * P2：开发截图/QA 环境变量逻辑，从主窗口生命周期中拆出。
 * 只在未打包构建中由 createWindow 调用；生产入口不含任何 QA 分支。
 */

export interface QaAutomationDeps {
  mainWindow: BrowserWindow | null;
  quit(): void;
  exit(code: number): void;
  log(line: string): void;
}

export function runQaAutomation(deps: QaAutomationDeps): void {
  // BUG-055：纵深熔断——打包生产版即使被误接线也不执行任何 QA 自动化。
  if (app.isPackaged) {
    console.warn('Chromik: QA 自动化在打包构建中被禁用');
    return;
  }
  const { mainWindow, quit, exit, log } = deps;

  if (process.env.FILMLAB_CAPTURE_VIEW === 'develop') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.library-view-tabs button')].find((button) => button.textContent?.includes('处理后画面'))?.click();
      `);
    }, 500);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        document.querySelector('.photo-grid .photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      `);
    }, 900);
  }

  if (process.env.FILMLAB_CAPTURE_VIEW === 'segment') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.library-view-tabs button')].find((button) => button.textContent?.includes('原始文件'))?.click();
      `);
    }, 350);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        document.querySelector('.asset-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      `);
    }, 850);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('生成') && button.textContent?.includes('张建议'))?.click();
      `);
    }, 1600);
  }

  if (process.env.FILMLAB_CAPTURE_VIEW === 'calibrate') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.library-view-tabs button')].find((button) => button.textContent?.includes('原始文件'))?.click();
      `);
    }, 350);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('进入整卷校准'))?.click();
      `);
    }, 700);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('采样并'))?.click();
      `);
    }, 3300);
  }

  if (process.env.FILMLAB_CAPTURE_VIEW === 'export') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.library-view-tabs button')].find((button) => button.textContent?.includes('处理后画面'))?.click();
      `);
    }, 500);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.library-commandbar button')].find((button) => button.textContent?.includes('导出'))?.click();
      `);
    }, 900);
  }

  if (process.env.FILMLAB_CAPTURE_VIEW === 'settings') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        document.querySelector('button[aria-label="设置"]')?.click();
      `);
    }, 700);
  }

  if (process.env.FILMLAB_QA_PREVIEW_NAV) {
    setTimeout(() => {
      mainWindow?.webContents.sendInputEvent({ type: 'mouseWheel', x: 760, y: 450, deltaX: 0, deltaY: -260, canScroll: true });
    }, 3100);
    setTimeout(() => {
      mainWindow?.webContents.sendInputEvent({ type: 'mouseDown', x: 700, y: 450, button: 'middle', clickCount: 1 });
      mainWindow?.webContents.sendInputEvent({ type: 'mouseMove', x: 790, y: 510, button: 'middle' });
      mainWindow?.webContents.sendInputEvent({ type: 'mouseUp', x: 790, y: 510, button: 'middle', clickCount: 1 });
    }, 3700);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('编辑四角'))?.click();
      `);
    }, 4300);
  }

  if (process.env.FILMLAB_QA_GPU_PREVIEW) {
    const DRAG_TICKS = 40; // 40 次输入事件，采集足够多的合并帧样本
    const DRAG_INTERVAL_MS = 45;
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`(() => {
        const slider = document.querySelector('.range-input');
        if (!(slider instanceof HTMLInputElement)) return false;
        slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
        let ticks = 0;
        const timer = setInterval(() => {
          const nextValue = String(Math.min(Number(slider.max), Number(slider.value) + Number(slider.step || 1)));
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, nextValue);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
          ticks += 1;
          if (ticks >= ${DRAG_TICKS}) {
            clearInterval(timer);
            setTimeout(() => slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })), 120);
          }
        }, ${DRAG_INTERVAL_MS});
        return true;
      })()`);
    }, 1700);
    setTimeout(async () => {
      const result = await mainWindow?.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector('.develop-stage canvas');
        return canvas instanceof HTMLCanvasElement ? { backend: canvas.dataset.previewBackend, durationMs: Number(canvas.dataset.previewDurationMs), lastGpuDurationMs: Number(canvas.dataset.lastGpuDurationMs), minGpuDurationMs: Number(canvas.dataset.minGpuDurationMs), maxGpuDurationMs: Number(canvas.dataset.maxGpuDurationMs), gpuFrameCount: Number(canvas.dataset.gpuFrameCount), validation: canvas.dataset.gpuValidation ? JSON.parse(canvas.dataset.gpuValidation) : null, width: canvas.width, height: canvas.height } : null;
      })()`);
      log(`CHROMIK_GPU_PREVIEW ${JSON.stringify(result)}`);
      // QA-02：GPU 与 CPU 参考的像素误差越过 §13.1 阈值时，QA 进程以失败退出。
      if (result?.validation && result.validation.passed === false) {
        log(`CHROMIK_GPU_VALIDATE_FAILED ${JSON.stringify(result.validation)}`);
        exit(1);
      }
    }, 1700 + DRAG_TICKS * DRAG_INTERVAL_MS + 1600);
  }

  if (process.env.FILMLAB_QA_RAW_CORPUS_DIR) {
    setTimeout(async () => {
      const result = await mainWindow?.webContents.executeJavaScript(`new Promise((resolve) => {
        let attempts = 0;
        const tryClick = () => {
          attempts += 1;
          const tab = [...document.querySelectorAll('.library-view-tabs button')].find((button) => button.textContent?.includes('原始文件'));
          tab?.click();
          setTimeout(() => {
            const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('添加原始素材'));
            if (button instanceof HTMLButtonElement && !button.disabled) { button.click(); resolve({ clicked: true, attempts, label: button.textContent }); return; }
            if (attempts >= 50) { resolve({ clicked: false, attempts, labels: [...document.querySelectorAll('button')].map((item) => item.textContent).filter(Boolean).slice(0, 30) }); return; }
            setTimeout(tryClick, 200);
          }, 80);
        };
        tryClick();
      })`);
      log(`CHROMIK_RAW_QA_TRIGGER ${JSON.stringify(result)}`);
    }, 500);
  }

  if (process.env.FILMLAB_QA_CROP) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('.editor-toolrail button')].find((button) => button.textContent?.trim() === '裁切')?.click();
      `);
    }, 3000);
  }

  if (process.env.FILMLAB_QA_BASE_SAMPLE) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('summary')].find((summary) => summary.textContent?.includes('手动校正片基'))?.click();
      `);
    }, 2800);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('显示完整素材并选择片基'))?.click();
      `);
    }, 3200);
  }

  if (process.env.FILMLAB_QA_FRAMER_MAGNIFIER) {
    setTimeout(async () => {
      if (!mainWindow) return;
      const point = await mainWindow.webContents.executeJavaScript(`(() => {
        const circle = document.querySelector('.framer-media svg circle');
        if (!(circle instanceof SVGCircleElement)) return null;
        const bounds = circle.getBoundingClientRect();
        return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
      })()`);
      if (!point) return;
      mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 22, y: point.y + 14, button: 'left' });
    }, 2200);
  }

  if (process.env.FILMLAB_QA_FRAMER_CONTINUOUS) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '添加帧')?.click();
      `);
    }, 1900);
    setTimeout(async () => {
      if (!mainWindow) return;
      const bounds = await mainWindow.webContents.executeJavaScript(`(() => {
        const stage = document.querySelector('.framer-stage');
        if (!(stage instanceof HTMLElement)) return null;
        const rect = stage.getBoundingClientRect();
        return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      })()`);
      if (!bounds) return;
      for (const offset of [0, 150]) {
        const x = bounds.x + 240 + offset;
        const y = bounds.y + 230;
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: x + 110, y: y + 90, button: 'left' });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: x + 110, y: y + 90, button: 'left', clickCount: 1 });
      }
      setTimeout(async () => {
        const result = await mainWindow?.webContents.executeJavaScript(`(() => ({
          addingActive: document.querySelector('.framer-tools button:nth-of-type(2)')?.classList.contains('active'),
          regions: document.querySelectorAll('.framer-media svg polygon').length,
          hint: document.querySelector('.framer-hint')?.textContent,
        }))()`);
        log(`CHROMIK_CONTINUOUS_FRAMES ${JSON.stringify(result)}`);
      }, 250);
    }, 2250);
  }

  if (process.env.FILMLAB_QA_SAVE_FRAMES) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')].find((button) => button.textContent?.trim().startsWith('保存 '))?.click();
      `);
    }, 2100);
  }

  if (process.env.FILMLAB_QA_LIVE_SLIDER) {
    setTimeout(async () => {
      if (!mainWindow) return;
      const before = await mainWindow.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.adjustment-panel input[type="range"]');
        const canvas = document.querySelector('.develop-stage canvas');
        if (!(input instanceof HTMLInputElement) || !(canvas instanceof HTMLCanvasElement)) return null;
        const bounds = input.getBoundingClientRect();
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
        let sample = 0;
        if (pixels) for (let index = 0; index < pixels.length; index += Math.max(4, Math.floor(pixels.length / 160))) sample = (sample + pixels[index]) % 1000000007;
        const minimum = Number(input.min || 0);
        const maximum = Number(input.max || 100);
        const value = Number(input.value);
        const fraction = (value - minimum) / Math.max(.0001, maximum - minimum);
        return { x: bounds.left + bounds.width * fraction, y: bounds.top + bounds.height / 2, width: bounds.width, value: input.value, direction: fraction > .55 ? -1 : 1, sample };
      })()`);
      if (!before) return;
      mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(before.x), y: Math.round(before.y), button: 'left', clickCount: 1 });
      const destinationX = Math.round(before.x + before.width * .3 * before.direction);
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: destinationX, y: Math.round(before.y), button: 'left' });
      setTimeout(async () => {
        if (!mainWindow) return;
        const during = await mainWindow.webContents.executeJavaScript(`(() => {
          const input = document.querySelector('.adjustment-panel input[type="range"]');
          const canvas = document.querySelector('.develop-stage canvas');
          if (!(input instanceof HTMLInputElement) || !(canvas instanceof HTMLCanvasElement)) return null;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
          let sample = 0;
          if (pixels) for (let index = 0; index < pixels.length; index += Math.max(4, Math.floor(pixels.length / 160))) sample = (sample + pixels[index]) % 1000000007;
          return { value: input.value, sample };
        })()`);
        log(`CHROMIK_LIVE_PREVIEW ${JSON.stringify({ before: { value: before.value, sample: before.sample }, during, changedBeforeRelease: Boolean(during && during.sample !== before.sample) })}`);
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: destinationX, y: Math.round(before.y), button: 'left', clickCount: 1 });
      }, 650);
    }, 4000);
  }

  if (process.env.FILMLAB_QA_CURVE) {
    setTimeout(async () => {
      if (!mainWindow) return;
      await mainWindow.webContents.executeJavaScript(`
        [...document.querySelectorAll('.adjust-nav button')].find((button) => button.textContent?.trim() === '曲线')?.click();
      `);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const bounds = await mainWindow.webContents.executeJavaScript(`(() => {
        const scroll = document.querySelector('.adjustment-panel .panel-scroll');
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
        const curve = document.querySelector('.curve-editor');
        if (!(curve instanceof SVGElement)) return null;
        const rect = curve.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, before: curve.querySelectorAll('circle').length };
      })()`);
      if (!bounds) return;
      const x = Math.round(bounds.x + bounds.width * .47);
      const y = Math.round(bounds.y + bounds.height * .64);
      mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      setTimeout(async () => {
        if (!mainWindow) return;
        const added = await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('.curve-editor circle').length`);
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
        setTimeout(async () => {
          if (!mainWindow) return;
          const removed = await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('.curve-editor circle').length`);
          log(`CHROMIK_CURVE_ANCHORS ${JSON.stringify({ before: bounds.before, added, removed, passed: added === bounds.before + 1 && removed === bounds.before })}`);
        }, 180);
      }, 180);
    }, 3300);
  }

  if (process.env.FILMLAB_QA_INFO_TIP) {
    setTimeout(async () => {
      if (!mainWindow) return;
      const anchor = await mainWindow.webContents.executeJavaScript(`(() => {
        const tip = document.querySelector('.info-tip');
        if (!(tip instanceof HTMLElement)) return null;
        const rect = tip.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (!anchor) return;
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: anchor.x, y: anchor.y });
      setTimeout(async () => {
        const result = await mainWindow?.webContents.executeJavaScript(`(() => {
          const popover = document.querySelector('body > .info-tip-popover');
          if (!(popover instanceof HTMLElement)) return null;
          const rect = popover.getBoundingClientRect();
          return { portal: popover.parentElement === document.body, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
            fullyVisible: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
        })()`);
        log(`CHROMIK_INFO_TIP ${JSON.stringify(result)}`);
      }, 250);
    }, 2500);
  }

  if (process.env.FILMLAB_CAPTURE_PATH) {
    const defaultCaptureDelay = process.env.FILMLAB_CAPTURE_VIEW === 'calibrate'
      ? 7000
      : ['develop', 'export'].includes(process.env.FILMLAB_CAPTURE_VIEW ?? '') ? 5200 : 3000;
    const requestedCaptureDelay = Number(process.env.FILMLAB_CAPTURE_DELAY_MS);
    const captureDelay = Number.isFinite(requestedCaptureDelay) && requestedCaptureDelay >= 500
      ? requestedCaptureDelay
      : defaultCaptureDelay;
    setTimeout(async () => {
      if (!mainWindow) return;
      if (process.env.FILMLAB_QA_LIBRARY_COUNT) {
        const result = await mainWindow.webContents.executeJavaScript(`(() => { const grid = document.querySelector('.virtual-photo-grid'); return { expected: ${JSON.stringify(Number(process.env.FILMLAB_QA_LIBRARY_COUNT))}, items: grid?.getAttribute('data-item-count'), cards: document.querySelectorAll('.photo-grid .photo-card').length, images: document.querySelectorAll('.photo-grid img').length, rows: grid?.getAttribute('aria-rowcount'), columns: grid?.getAttribute('aria-colcount'), exportRows: document.querySelectorAll('.export-list .export-row').length, filmstripItems: document.querySelectorAll('.virtual-filmstrip button').length }; })()`);
        log(`CHROMIK_LIBRARY_DOM ${JSON.stringify(result)}`);
      }
      const targetView = process.env.FILMLAB_CAPTURE_VIEW ?? 'unknown';
      const expectedSelectors: Record<string, string> = {
        library: '.library-layout',
        calibrate: '.calibration-preview',
        segment: '.framer-media',
        develop: '.develop-stage',
        export: '.export-layout',
        settings: '.settings-page',
      };
      const expectedSelector = expectedSelectors[targetView];
      const captureState = await mainWindow.webContents.executeJavaScript(`(() => {
        const selector = ${JSON.stringify(expectedSelector)};
        return {
          view: ${JSON.stringify(targetView)},
          selector,
          matched: Boolean(selector && document.querySelector(selector)),
          title: document.querySelector('h1, h2, .editor-title')?.textContent?.trim() ?? '',
        };
      })()`);
      log(`CHROMIK_CAPTURE_STATE ${JSON.stringify(captureState)}`);
      const image = await mainWindow.webContents.capturePage();
      await fs.mkdir(path.dirname(process.env.FILMLAB_CAPTURE_PATH!), { recursive: true });
      await fs.writeFile(process.env.FILMLAB_CAPTURE_PATH!, image.toPNG());
      if (!captureState.matched) {
        log(`CHROMIK_CAPTURE_FAILED ${JSON.stringify(captureState)}`);
        exit(1);
      } else {
        quit();
      }
    }, captureDelay);
  }
}
