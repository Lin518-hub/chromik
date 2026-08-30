import type { ComponentType } from 'react';

export type EditorToolId = 'calibrate' | 'segment' | 'adjust' | 'crop' | 'dust';
export type EditorScope = 'roll' | 'asset' | 'frame';

export interface EditorContext {
  hasRoll: boolean;
  hasAssets: boolean;
  hasFrames: boolean;
}

// 新工具只需要在这里注册自己的作用范围、可用条件和参数面板。
// 目前几个核心面板仍由 App 持有状态，未来工具可直接提供 inspector / overlay。
export interface EditorTool {
  id: EditorToolId;
  label: string;
  description: string;
  scope: EditorScope;
  scopeLabel: string;
  inspector?: ComponentType;
  overlay?: ComponentType;
  isAvailable: (context: EditorContext) => boolean;
}

export const EDITOR_TOOLS: readonly EditorTool[] = [
  {
    id: 'segment',
    label: '分帧',
    description: '从当前原始素材中划分单张画面',
    scope: 'asset',
    scopeLabel: '当前素材',
    isAvailable: (context) => context.hasAssets,
  },
  {
    id: 'calibrate',
    label: '校准',
    description: '片种、自动转换、片基与输入设备校准',
    scope: 'roll',
    scopeLabel: '整卷',
    isAvailable: (context) => context.hasRoll && context.hasFrames,
  },
  {
    id: 'adjust',
    label: '调整',
    description: '单张画面的影调、色彩、风格与曲线',
    scope: 'frame',
    scopeLabel: '当前照片',
    isAvailable: (context) => context.hasFrames,
  },
  {
    id: 'crop',
    label: '裁切',
    description: '单张画面的边界、拉直和镜头几何',
    scope: 'frame',
    scopeLabel: '当前照片',
    isAvailable: (context) => context.hasFrames,
  },
  {
    id: 'dust',
    label: '除尘',
    description: '在单张画面上点选灰尘并控制修复范围',
    scope: 'frame',
    scopeLabel: '当前照片',
    isAvailable: (context) => context.hasFrames,
  },
] as const;

const EDITOR_TOOLS_BY_ID = new Map<EditorToolId, EditorTool>(EDITOR_TOOLS.map((tool) => [tool.id, tool]));

export function editorToolDefinition(id: EditorToolId): EditorTool {
  // BUG-048：按 id 映射兜底到「调整」，不再依赖数组顺序的魔法索引。
  return EDITOR_TOOLS_BY_ID.get(id) ?? EDITOR_TOOLS_BY_ID.get('adjust')!;
}
