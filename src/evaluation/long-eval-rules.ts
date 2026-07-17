export type LongRpScene = "dock" | "weather-station" | "archive";

const sceneTerms: Record<LongRpScene, readonly string[]> = {
  dock: ["码头", "栈桥", "引航员", "泊位", "吊机", "潮水", "仓库"],
  "weather-station": [
    "气象站",
    "山顶",
    "控制室",
    "发射器",
    "天线",
    "示波器",
    "风速仪",
    "校准",
    "频率",
  ],
  archive: ["档案库", "地下", "记录", "档案", "卷宗", "资料", "档案柜", "防火门"],
};

export function longRpSceneForTurn(modeTurn: number): LongRpScene {
  if (modeTurn <= 10) return "dock";
  if (modeTurn <= 20) return "weather-station";
  return "archive";
}

export function longRpSceneTerms(scene: LongRpScene): readonly string[] {
  return sceneTerms[scene];
}

export function hasLongRpSceneContinuity(text: string, scene: LongRpScene): boolean {
  return sceneTerms[scene].some((term) => text.includes(term));
}
