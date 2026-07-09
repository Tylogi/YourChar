import {
  type AgentContext,
  type AgentMessage,
  assistantToolCall,
  textMessage,
  textOf,
  toolResultsOf,
} from "../harness/index.js";
import { extractReminderTitle, parseReminderTime, resolveNow } from "./time.js";
import type { MessageRequest, Mode, Reminder } from "./types.js";

export async function companionModel(context: AgentContext): Promise<AgentMessage> {
  const request = context.state.request as MessageRequest;
  const mode = (request.mode ?? "sms") as Mode;
  const last = context.messages.at(-1);

  if (last?.role === "tool") {
    return renderToolResult(mode, last);
  }

  const userText = last ? textOf(last).trim() : "";
  if (isRealReminderIntent(userText)) {
    const now = resolveNow(request.now);
    const remindAt = parseReminderTime(userText, now).toISOString();
    const title = extractReminderTitle(userText);
    return {
      ...textMessage("assistant", ""),
      content: [
        assistantToolCall("create_reminder", {
          title,
          remindAt,
          timezone: request.timezone ?? "Asia/Shanghai",
        }),
      ],
    };
  }

  if (mode === "rp" && userText) {
    return {
      ...textMessage("assistant", ""),
      content: [
        assistantToolCall("write_memory", {
          content: userText,
          tags: ["rp", "scene"],
        }),
      ],
    };
  }

  return textMessage("assistant", mode === "sms" ? "收到。" : "她轻轻点头，把这一刻留在安静的间隙里。");
}

function renderToolResult(mode: Mode, message: AgentMessage): AgentMessage {
  const result = toolResultsOf(message)[0];
  if (!result || result.isError) {
    return textMessage("assistant", "这步没有处理成功。");
  }
  if (result.name === "create_reminder") {
    const reminder = result.content as Reminder;
    if (mode === "rp") {
      return textMessage("assistant", `她把提醒写进现实清单：${reminder.title}，${reminder.remindAt}。`);
    }
    return textMessage("assistant", `已设置提醒：${reminder.title}，时间 ${reminder.remindAt}。`);
  }
  if (result.name === "write_memory") {
    return textMessage(
      "assistant",
      "她没有把这当成现实日程，只是把刚才的场景收进共同记忆里。",
    );
  }
  return textMessage("assistant", "处理好了。");
}

function isRealReminderIntent(text: string): boolean {
  if (hasFictionMarker(text)) {
    return false;
  }
  return /提醒我|提醒一下|记得提醒/.test(text);
}

function hasFictionMarker(text: string): boolean {
  return /剧情|故事|设定|角色|场景|虚构|剧本|世界观/i.test(text);
}
