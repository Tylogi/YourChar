import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { ImIntegrationService } from "../im/service.js";
import type { ImProvider } from "../im/types.js";
import type { DeliveryResult, NotificationDelivery, NotificationSink } from "./sink.js";

export const reminderCode = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0,10);

export class ImNotificationSink implements NotificationSink {
  constructor(readonly channel: ImProvider, private readonly im: ImIntegrationService, private readonly clock: Clock) {}
  async deliver(notification: NotificationDelivery): Promise<DeliveryResult> {
    const code = reminderCode(notification.occurrenceId);
    const item = this.im.repository.enqueueNotification({ id: "im-reminder:" + notification.outboxId,
      provider: this.channel, notificationId: notification.outboxId, now: this.clock.now().toISOString(),
      text: "【日程提醒】\n" + notification.body + "\n\n回复「知道了 " + code + "」确认，或「稍后提醒 " + code + " 10」延后 10 分钟。" });
    if (item.status === "delivered") return { delivered: true };
    if (item.status === "abandoned") throw new Error(item.lastError || "提醒绑定已失效，请在 UI 中检查");
    if (item.status === "failed" && item.attempts >= 3) throw new Error(item.lastError || "通道多次投递失败，请在 UI 中重试");
    return { delivered: false, pending: true, detail: item.lastError };
  }
}
